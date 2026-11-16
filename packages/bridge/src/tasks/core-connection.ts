import {
  createClient,
  type EventSnapshot,
  type EventSubscription,
  type HcClient,
} from "@herdr-mobile/hc-client";
import type { HcEvent, HcMethod } from "@herdr-mobile/protocol";
import { type Clock, DeadlineError, systemClock, within } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { connectEnv } from "../server/connect-env.ts";
import { CONNECT_SHUTDOWN_MS } from "../server/session.ts";

export const CORE_CONNECTION_STAGE_MS = 10_000;
export const CORE_CONNECTION_STALE_MS = 40_000;
export const CORE_CONNECTION_RECONNECT_MS = 60_000;
export const CORE_CONNECTION_CLOSE_MS = 1_000;
export const CORE_CONNECTION_EXIT_GRACE_MS = 2_000;

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const BACKOFF_JITTER = 0.2;

export type CoreConnectionState =
  | "stopped"
  | "connecting"
  | "live"
  | "stale"
  | "backoff"
  | "parked"
  | "stopping";

export interface CoreConnectionStatus {
  state: CoreConnectionState;
  since: number;
  seq?: number;
  reconnects: number;
  lastEventAt?: number;
  lastError?: string;
}

export interface CoreConnectionDependencies {
  runner: ProcessRunner;
  hcPath: string;
  session?: string;
  env: Record<string, string>;
  cwd: string;
  clock?: Clock;
  random?: () => number;
}

export interface CoreConnectionCallbacks {
  onSnapshot(snapshot: EventSnapshot): void;
  onEvent(event: HcEvent): void;
  onState(status: CoreConnectionStatus): void;
}

export type CoreConnectionEndTrigger =
  | "output-close"
  | "exit"
  | "subscription-end"
  | "watchdog"
  | "client-error";

export interface CoreConnectionEndObservation {
  subscribed: boolean;
  trigger: CoreConnectionEndTrigger;
  exitedNaturally: boolean;
  exitCode: number | null | undefined;
  serverStopComplete: boolean;
}

/** Classifies one complete attempt observation without changing connection state. */
export function classifyEnd(observation: CoreConnectionEndObservation): "parked" | "backoff" {
  if (
    !observation.subscribed ||
    observation.trigger === "watchdog" ||
    observation.trigger === "client-error" ||
    !observation.exitedNaturally
  ) {
    return "backoff";
  }
  if (observation.exitCode === 0 || observation.serverStopComplete) return "parked";
  return "backoff";
}

type AttemptEnd =
  | { kind: "exit"; code: number | null }
  | { kind: "output" }
  | { kind: "subscription"; end: Awaited<EventSubscription["closed"]> }
  | { kind: "watchdog" }
  | { kind: "client"; cause: unknown };

interface Attempt {
  child: OwnedProcess;
  client: HcClient;
  abort: AbortController;
  subscription: EventSubscription | undefined;
  subscribed: boolean;
  heartbeatSeen: boolean;
  liveAddresses: Set<string>;
  serverStopSeen: boolean;
  serverStopIncomplete: boolean;
  snapshotSeen: boolean;
  trigger: AttemptEnd | undefined;
  clientErrorSeen: boolean;
  clientErrorCause: unknown;
  settlementStarted: boolean;
  cancelled: boolean;
  resolveCancelled(): void;
  cancelledPromise: Promise<void>;
  outputClosed: boolean;
  resolveOutputClosed(): void;
  outputClosedPromise: Promise<void>;
  exitSettled: boolean;
  exitCode: number | null | undefined;
  exitAt: number | undefined;
  resolveExit(): void;
  exitPromise: Promise<void>;
  exitedNaturally: boolean;
  killed: boolean;
  staleTimer: unknown;
  reconnectTimer: unknown;
  settlementTimer: unknown;
}

interface RetryTimer {
  timer: unknown;
  cancelled: boolean;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isServerStop(event: HcEvent): boolean {
  if (event.type !== "finished" || typeof event.data !== "object" || event.data === null) {
    return false;
  }
  return !Array.isArray(event.data) && event.data.reason === "server_stop";
}

/** Owns one long-lived, framed `hc connect` subscription and its reconnect policy. */
export class CoreConnection {
  private readonly dependencies: CoreConnectionDependencies;
  private readonly callbacks: CoreConnectionCallbacks;
  private readonly clock: Clock;
  private readonly random: () => number;
  private state: CoreConnectionState = "stopped";
  private since: number;
  private seq: number | undefined;
  private reconnects = 0;
  private lastEventAt: number | undefined;
  private lastError: string | undefined;
  private current: Attempt | undefined;
  private reaping: OwnedProcess | undefined;
  private queuedStart = false;
  private started = false;
  private backoffIndex = 0;
  private retry: RetryTimer | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(dependencies: CoreConnectionDependencies, callbacks: CoreConnectionCallbacks) {
    this.dependencies = dependencies;
    this.callbacks = callbacks;
    this.clock = dependencies.clock ?? systemClock;
    this.random = dependencies.random ?? Math.random;
    this.since = this.clock.now();
  }

  /** Starts a connection attempt and returns without waiting for the core. */
  start(): void {
    if (this.started || this.state !== "stopped") return;
    this.started = true;
    this.beginAttempt();
  }

  /** Resumes immediately only after a deliberate `server_stop` parked the connection. */
  resume(): void {
    if (this.state !== "parked") return;
    this.started = true;
    this.beginAttempt();
  }

  status(): CoreConnectionStatus {
    return {
      state: this.state,
      since: this.since,
      ...(this.seq === undefined ? {} : { seq: this.seq }),
      reconnects: this.reconnects,
      ...(this.lastEventAt === undefined ? {} : { lastEventAt: this.lastEventAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  call(method: HcMethod, params: unknown): Promise<unknown> {
    const attempt = this.current;
    if (this.state !== "live" || !attempt?.client.acceptsCalls) {
      return Promise.reject(new Error("core connection is not live"));
    }
    return attempt.client.call(method, params as never);
  }

  /** Closes the subscription, then the child, with a six-second overall bound. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped") return Promise.resolve();

    this.started = false;
    this.queuedStart = false;
    this.clearRetry();
    const attempt = this.current;
    if (attempt) {
      attempt.cancelled = true;
      this.resolveCancelled(attempt);
      this.clearAttemptTimers(attempt);
      this.current = undefined;
      attempt.abort.abort(new Error("core connection stopping"));
    }
    this.setState("stopping");

    this.stopPromise = this.stopAttempt(attempt).finally(() => {
      this.setState("stopped");
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private beginAttempt(): void {
    if (!this.started || this.state === "stopping") return;
    this.clearRetry();
    this.setState("connecting");
    if (!this.started) return;
    if (this.current) return;
    if (this.reaping) {
      this.queuedStart = true;
      return;
    }
    this.queuedStart = false;

    let child: OwnedProcess;
    try {
      child = this.dependencies.runner.spawn([this.dependencies.hcPath, "connect"], {
        env: connectEnv(this.dependencies.env, { session: this.dependencies.session }),
        cwd: this.dependencies.cwd,
      });
    } catch (error) {
      this.scheduleBackoff(error);
      return;
    }

    const attempt = this.makeAttempt(child);
    this.current = attempt;
    this.reaping = child;
    this.observeProcess(attempt);
    this.readChild(attempt);
    void this.runAttempt(attempt);
  }

  private makeAttempt(child: OwnedProcess): Attempt {
    let resolveCancelled: () => void = () => {};
    let resolveOutputClosed: () => void = () => {};
    let resolveExit: () => void = () => {};
    return {
      child,
      client: createClient({
        write: (bytes) => child.write(bytes),
        requestTransportClose: () => child.closeInput(),
      }),
      abort: new AbortController(),
      subscription: undefined,
      subscribed: false,
      heartbeatSeen: false,
      liveAddresses: new Set(),
      serverStopSeen: false,
      serverStopIncomplete: false,
      snapshotSeen: false,
      trigger: undefined,
      clientErrorSeen: false,
      clientErrorCause: undefined,
      settlementStarted: false,
      cancelled: false,
      resolveCancelled: () => resolveCancelled(),
      cancelledPromise: new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      }),
      outputClosed: false,
      resolveOutputClosed: () => resolveOutputClosed(),
      outputClosedPromise: new Promise<void>((resolve) => {
        resolveOutputClosed = resolve;
      }),
      exitSettled: false,
      exitCode: undefined,
      exitAt: undefined,
      resolveExit: () => resolveExit(),
      exitPromise: new Promise<void>((resolve) => {
        resolveExit = resolve;
      }),
      exitedNaturally: false,
      killed: false,
      staleTimer: undefined,
      reconnectTimer: undefined,
      settlementTimer: undefined,
    };
  }

  private owns(attempt: Attempt): boolean {
    return !attempt.cancelled && this.current === attempt;
  }

  private observeProcess(attempt: Attempt): void {
    void attempt.child.exited.then(
      () => this.releaseProcessGate(attempt.child),
      () => {},
    );
    void attempt.child.exited.then(
      (code) => {
        if (!this.owns(attempt)) return;
        attempt.exitSettled = true;
        attempt.exitCode = code;
        attempt.exitAt = this.clock.now();
        attempt.resolveExit();
        this.triggerEnd(attempt, { kind: "exit", code });
      },
      (cause: unknown) => {
        if (!this.owns(attempt)) return;
        this.triggerEnd(attempt, { kind: "client", cause });
      },
    );
  }

  private releaseProcessGate(child: OwnedProcess): void {
    if (this.reaping !== child) return;
    this.reaping = undefined;
    if (!this.queuedStart) return;
    if (!this.started || this.state === "stopping") {
      this.queuedStart = false;
      return;
    }
    this.queuedStart = false;
    this.beginAttempt();
  }

  private readChild(attempt: Attempt): void {
    attempt.child.read(
      (bytes) => {
        if (!this.owns(attempt)) return;
        try {
          attempt.client.feed(bytes);
        } catch (cause) {
          if (!this.owns(attempt)) return;
          attempt.client.end(cause);
          this.triggerEnd(attempt, { kind: "client", cause });
        }
      },
      () => {
        if (!this.owns(attempt)) return;
        attempt.outputClosed = true;
        attempt.resolveOutputClosed();
        this.triggerEnd(attempt, { kind: "output" });
        attempt.client.end();
      },
    );
    void attempt.client.closed.then((cause) => {
      if (!this.owns(attempt)) return;
      if (cause !== undefined) this.triggerEnd(attempt, { kind: "client", cause });
    });
  }

  private async runAttempt(attempt: Attempt): Promise<void> {
    try {
      await within(
        "hc connect hello",
        attempt.client.hello({ framed: true }),
        CORE_CONNECTION_STAGE_MS,
        this.clock,
        attempt.abort.signal,
      );
      if (!this.owns(attempt)) return;
      if (attempt.trigger) return;

      const subscribing = attempt.client.subscribeEvents(
        {},
        {
          onSnapshot: (snapshot) => this.handleSnapshot(attempt, snapshot),
          onEvent: (event) => this.handleEvent(attempt, event),
          onHeartbeat: (seq) => this.handleHeartbeat(attempt, seq),
        },
      );
      const subscription = await within(
        "hc connect events.subscribe",
        subscribing,
        CORE_CONNECTION_STAGE_MS,
        this.clock,
        attempt.abort.signal,
      );
      if (!this.owns(attempt)) {
        void subscription.close().catch(() => {});
        return;
      }

      attempt.subscription = subscription;
      attempt.subscribed = true;
      void subscription.closed.then((end) => {
        if (!this.owns(attempt)) return;
        this.triggerEnd(attempt, { kind: "subscription", end });
      });
      if (attempt.trigger) return;

      this.lastEventAt = this.clock.now();
      this.setState("live");
      this.armStaleTimer(attempt);
    } catch (cause) {
      if (!this.owns(attempt)) return;
      this.triggerEnd(attempt, { kind: "client", cause });
    }
  }

  private triggerEnd(attempt: Attempt, end: AttemptEnd): void {
    if (!this.owns(attempt)) return;
    if (end.kind === "client") {
      attempt.clientErrorSeen = true;
      attempt.clientErrorCause = end.cause;
    }
    if (attempt.settlementStarted) return;
    attempt.trigger = end;
    attempt.settlementStarted = true;
    this.clearAttemptWatchdogTimers(attempt);
    void this.settleAttempt(attempt, end);
  }

  private async settleAttempt(attempt: Attempt, end: AttemptEnd): Promise<void> {
    if (!this.owns(attempt)) return;
    const deadline = this.clock.now() + CORE_CONNECTION_EXIT_GRACE_MS;
    let timer: unknown;
    const grace = new Promise<"grace">((resolve) => {
      timer = this.clock.setTimeout(() => resolve("grace"), CORE_CONNECTION_EXIT_GRACE_MS);
      attempt.settlementTimer = timer;
    });
    const joined = Promise.all([attempt.outputClosedPromise, attempt.exitPromise]).then(
      () => "joined" as const,
    );
    const cancelled = attempt.cancelledPromise.then(() => "cancelled" as const);
    const outcome = await Promise.race([joined, grace, cancelled]);
    if (!this.owns(attempt)) return;

    if (timer !== undefined) this.clock.clearTimeout(timer);
    attempt.settlementTimer = undefined;
    if (outcome === "cancelled") return;

    attempt.exitedNaturally =
      attempt.exitSettled &&
      attempt.exitAt !== undefined &&
      attempt.exitAt <= deadline &&
      !attempt.killed;
    if (!attempt.exitSettled) {
      attempt.killed = true;
      try {
        attempt.child.kill();
      } catch {
        // The process gate remains held until its actual exit promise settles.
      }
    }

    const serverStopComplete =
      attempt.serverStopSeen && !attempt.serverStopIncomplete && attempt.liveAddresses.size === 0;
    const effectiveEnd: AttemptEnd = attempt.clientErrorSeen
      ? { kind: "client", cause: attempt.clientErrorCause }
      : (attempt.trigger ?? end);
    const result = classifyEnd({
      subscribed: attempt.subscribed,
      trigger: this.classifierTrigger(effectiveEnd),
      exitedNaturally: attempt.exitedNaturally,
      exitCode: attempt.exitCode,
      serverStopComplete,
    });
    const failureEnd =
      effectiveEnd.kind === "watchdog" || effectiveEnd.kind === "client"
        ? effectiveEnd
        : attempt.exitSettled
          ? { kind: "exit" as const, code: attempt.exitCode ?? null }
          : effectiveEnd;
    const failure = this.endError(failureEnd);
    this.retireAttempt(attempt, failure);
    if (!this.started || this.state === "stopping") return;
    if (result === "parked") this.setState("parked");
    else this.scheduleBackoff(failure);
  }

  private classifierTrigger(end: AttemptEnd): CoreConnectionEndTrigger {
    if (end.kind === "output") return "output-close";
    if (end.kind === "exit") return "exit";
    if (end.kind === "subscription") return "subscription-end";
    if (end.kind === "watchdog") return "watchdog";
    return "client-error";
  }

  private handleSnapshot(attempt: Attempt, snapshot: EventSnapshot): void {
    if (!this.owns(attempt)) return;
    if (attempt.snapshotSeen) attempt.serverStopIncomplete = true;
    attempt.snapshotSeen = true;
    this.seq = snapshot.seq;
    attempt.liveAddresses = new Set(
      snapshot.terminals
        .filter((terminal) => terminal.state === "live")
        .map((terminal) => terminal.address),
    );
    this.lastEventAt = this.clock.now();
    this.touch(attempt);
    this.invoke(() => this.callbacks.onSnapshot(snapshot));
  }

  private handleEvent(attempt: Attempt, event: HcEvent): void {
    if (!this.owns(attempt)) return;
    this.seq = event.seq;
    this.lastEventAt = this.clock.now();
    this.touch(attempt);
    if (event.type === "created" || event.type === "restarted") {
      const terminal =
        typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
          ? (event.data as { address?: unknown; state?: unknown })
          : undefined;
      if (terminal?.state === "live" && typeof terminal.address === "string") {
        attempt.liveAddresses.add(terminal.address);
      }
    } else if (event.type === "finished" && event.terminal !== undefined) {
      if (attempt.liveAddresses.has(event.terminal)) {
        if (isServerStop(event)) attempt.serverStopSeen = true;
        else attempt.serverStopIncomplete = true;
      }
      attempt.liveAddresses.delete(event.terminal);
    } else if (event.type === "lost" || event.type === "removed") {
      if (event.terminal !== undefined) {
        if (attempt.liveAddresses.has(event.terminal)) attempt.serverStopIncomplete = true;
        attempt.liveAddresses.delete(event.terminal);
      }
    }
    this.invoke(() => this.callbacks.onEvent(event));
  }

  private handleHeartbeat(attempt: Attempt, seq: number): void {
    if (!this.owns(attempt)) return;
    this.seq = seq;
    this.lastEventAt = this.clock.now();
    if (!attempt.heartbeatSeen) {
      attempt.heartbeatSeen = true;
      this.backoffIndex = 0;
      this.lastError = undefined;
    }
    this.touch(attempt);
  }

  private touch(attempt: Attempt): void {
    if (!this.owns(attempt) || !attempt.subscribed) return;
    this.clearAttemptWatchdogTimers(attempt);
    if (this.state === "stale") this.setState("live");
    this.armStaleTimer(attempt);
  }

  private armStaleTimer(attempt: Attempt): void {
    if (!this.owns(attempt)) return;
    this.clearAttemptWatchdogTimers(attempt);
    attempt.staleTimer = this.clock.setTimeout(() => {
      if (!this.owns(attempt)) return;
      attempt.staleTimer = undefined;
      if (!attempt.subscribed) return;
      this.setState("stale");
      attempt.reconnectTimer = this.clock.setTimeout(() => {
        if (!this.owns(attempt)) return;
        attempt.reconnectTimer = undefined;
        this.triggerEnd(attempt, { kind: "watchdog" });
      }, CORE_CONNECTION_RECONNECT_MS - CORE_CONNECTION_STALE_MS);
    }, CORE_CONNECTION_STALE_MS);
  }

  private endError(end: AttemptEnd): unknown {
    if (end.kind === "watchdog") return new Error("core heartbeat watchdog expired");
    if (end.kind === "exit") {
      return new Error(`hc connect exited with ${end.code === null ? "a signal" : end.code}`);
    }
    if (end.kind === "client") return end.cause;
    if (end.kind === "subscription" && end.end.kind === "program") {
      return new Error(`events subscription ended: ${String(end.end.reason)}`);
    }
    return new Error("hc connect transport closed");
  }

  private retireAttempt(attempt: Attempt, cause: unknown): void {
    if (!this.owns(attempt)) return;
    attempt.cancelled = true;
    this.resolveCancelled(attempt);
    this.clearAttemptTimers(attempt);
    attempt.abort.abort(cause);
    try {
      attempt.client.end(cause);
    } catch {
      // The transport may already have ended.
    }
    try {
      attempt.child.closeInput();
    } catch {
      // The child may already have exited.
    }
    if (!attempt.exitSettled && !attempt.killed) {
      attempt.killed = true;
      try {
        attempt.child.kill();
      } catch {
        // The process gate remains held until its actual exit promise settles.
      }
    }
    this.current = undefined;
  }

  private scheduleBackoff(error: unknown): void {
    if (!this.started || this.state === "stopping") return;
    this.clearRetry();
    this.lastError = errorText(error);
    const step = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)] ?? 30_000;
    this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_MS.length - 1);
    const random = Math.max(0, Math.min(1, this.random()));
    const delay = Math.round(step * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random));
    this.reconnects += 1;
    this.setState("backoff");
    if (!this.started || this.state !== "backoff") return;
    const retry: RetryTimer = { timer: undefined, cancelled: false };
    retry.timer = this.clock.setTimeout(() => {
      if (this.retry !== retry || retry.cancelled || !this.started) return;
      this.retry = undefined;
      this.beginAttempt();
    }, delay);
    this.retry = retry;
  }

  private async stopAttempt(attempt: Attempt | undefined): Promise<void> {
    if (!attempt) return;
    if (attempt.subscription) {
      try {
        await within(
          "hc connect subscription close",
          attempt.subscription.close(),
          CORE_CONNECTION_CLOSE_MS,
          this.clock,
          new AbortController().signal,
        ).catch(() => {});
      } catch {
        // Continue with input closure if the core stopped accepting the subscription close.
      }
    }
    try {
      attempt.client.end(new Error("core connection stopped"));
    } catch {
      // The transport may already have ended.
    }
    try {
      attempt.child.closeInput();
    } catch {
      // The child may already have exited.
    }
    await within(
      "hc connect shutdown",
      attempt.child.exited.then(() => {}),
      CONNECT_SHUTDOWN_MS,
      this.clock,
      new AbortController().signal,
    ).catch((error: unknown) => {
      if (!(error instanceof DeadlineError)) return;
      try {
        attempt.child.kill();
      } catch {
        // stop() still completes when the child has already exited.
      }
    });
  }

  private clearAttemptWatchdogTimers(attempt: Attempt): void {
    if (attempt.staleTimer !== undefined) this.clock.clearTimeout(attempt.staleTimer);
    if (attempt.reconnectTimer !== undefined) this.clock.clearTimeout(attempt.reconnectTimer);
    attempt.staleTimer = undefined;
    attempt.reconnectTimer = undefined;
  }

  private clearAttemptTimers(attempt: Attempt): void {
    this.clearAttemptWatchdogTimers(attempt);
    if (attempt.settlementTimer !== undefined) {
      this.clock.clearTimeout(attempt.settlementTimer);
      attempt.settlementTimer = undefined;
    }
  }

  private resolveCancelled(attempt: Attempt): void {
    attempt.resolveCancelled();
  }

  private clearRetry(): void {
    const retry = this.retry;
    if (!retry) return;
    retry.cancelled = true;
    this.clock.clearTimeout(retry.timer);
    this.retry = undefined;
  }

  private setState(state: CoreConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.since = this.clock.now();
    this.invoke(() => this.callbacks.onState(this.status()));
  }

  private invoke(callback: () => void): void {
    try {
      callback();
    } catch {
      // Observers cannot disrupt the connection lifecycle.
    }
  }
}
