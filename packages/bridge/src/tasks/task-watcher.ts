import type { EventSnapshot } from "@herdr-mobile/hc-client";
import type { HcEvent, HcMethod, TaskOutcome, TaskRecord, Terminal } from "@herdr-mobile/protocol";
import { applyEvent, matchTerminal, oneLine } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock, within } from "../prototype/deadline.ts";
import type { CoreConnectionStatus } from "./core-connection.ts";
import type { MarkSource, Tracked } from "./task-knowledge.ts";
import {
  type classOf,
  desiredOutcome,
  mark,
  readAllowed,
  reduce,
  sameOutcome,
} from "./task-knowledge.ts";
import type { TaskStore } from "./task-store.ts";
import { TaskStoreError } from "./task-store.ts";

export const TASK_WATCHER_WRITE_COALESCE_MS = 300;
export const TASK_WATCHER_SUMMARY_DELAY_MS = 750;
export const TASK_WATCHER_SUMMARY_RETRY_MS = 2_000;
export const TASK_WATCHER_SUMMARY_CAP_MS = 3_000;
export const TASK_WATCHER_CONFLICT_RETRY_MS = 5_000;
export const TASK_WATCHER_MAX_CONFLICT_RETRIES = 3;

export type TaskTransitionKind = "needs-you" | "done" | "stopped";

export interface TaskTransition {
  kind: TaskTransitionKind;
  at: number;
  address: string;
  terminal: Terminal;
  record?: TaskRecord;
  turn: number;
  question?: string;
  summary?: string;
}

export type TaskTransitionSink = (transition: TaskTransition) => void;

export interface TaskWatcherConnection {
  start(): void;
  stop(): Promise<void>;
  resume(): void;
  status(): CoreConnectionStatus;
  call(method: HcMethod, params: unknown): Promise<unknown>;
}

export interface TaskWatcherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface TaskWatcherDependencies {
  connection: TaskWatcherConnection;
  store: TaskStore;
  clock?: Clock;
  logger: TaskWatcherLogger;
}

export interface TaskWatcherStatus extends CoreConnectionStatus {
  terminals: number;
  tracked: number;
  pendingWrites: number;
  lastWriteAt?: number;
}

interface ScheduledSummary {
  dueAt: number;
  handle: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalAddress(address: string): boolean {
  return !address.includes("/");
}

function errorCode(error: unknown): string {
  return error instanceof TaskStoreError ? error.code : "watcher_error";
}

function rowsFromRead(value: unknown): readonly string[] | undefined {
  if (!isObject(value) || typeof value.text !== "string") return undefined;
  return value.text.split(/\r?\n/u);
}

/** Keeps task outcomes and transition signals aligned with the current core terminal table. */
export class TaskWatcher {
  private readonly connection: TaskWatcherConnection;
  private readonly store: TaskStore;
  private readonly clock: Clock;
  private readonly logger: TaskWatcherLogger;
  private readonly transitionSinks = new Set<TaskTransitionSink>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly summaryTimers = new Map<string, ScheduledSummary>();
  private readonly activeReads = new Set<string>();
  private started = false;
  private hasSnapshot = false;
  private nextReadToken = 0;
  private reconcileInFlight = false;
  private reconcileAgain = false;
  private refreshTail: Promise<void> = Promise.resolve();
  private unsubscribeStore: (() => void) | undefined;
  private flushTimer: unknown;
  private retryTimer: unknown;
  private flushInFlight = false;
  private flushRetries = 0;
  private flushPaused = false;
  private tasksFullDrop = false;
  private lastWriteAt: number | undefined;
  private lastError: string | undefined;
  private connectionStatus: CoreConnectionStatus | undefined;

  constructor(dependencies: TaskWatcherDependencies) {
    this.connection = dependencies.connection;
    this.store = dependencies.store;
    this.clock = dependencies.clock ?? systemClock;
    this.logger = dependencies.logger;
  }

  /** Starts the connection without waiting for it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeStore = this.store.onChange(() => {
      if (!this.started) return;
      const changed = this.syncRecords();
      if (changed && !this.flushInFlight) this.resumeFlushAfterChange();
      this.requestReconcile();
    });
    try {
      this.connection.start();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Stops timers and listeners, then stops the long-lived core connection. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.clearTimer("flush");
    this.clearTimer("retry");
    for (const timer of this.summaryTimers.values()) this.clock.clearTimeout(timer.handle);
    this.summaryTimers.clear();
    this.activeReads.clear();
    try {
      await this.connection.stop();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Returns the current core connection status plus watcher-owned counts. */
  status(): TaskWatcherStatus {
    let connection: CoreConnectionStatus;
    try {
      connection = this.connection.status();
      this.connectionStatus = connection;
    } catch {
      connection =
        this.connectionStatus ??
        ({
          state: "stopped",
          since: this.clock.now(),
          reconnects: 0,
        } satisfies CoreConnectionStatus);
    }
    const records = Object.values(this.store.snapshot().tasks);
    return {
      ...connection,
      terminals: [...this.tracked.values()].filter((tracked) => tracked.present).length,
      tracked: records.filter((record) => {
        if (record.terminal === undefined || !isLocalAddress(record.terminal)) return false;
        return this.tracked.get(record.terminal)?.present === true;
      }).length,
      pendingWrites: this.pendingOutcomes().length,
      ...(this.lastWriteAt === undefined ? {} : { lastWriteAt: this.lastWriteAt }),
      ...((this.lastError ?? connection.lastError) === undefined
        ? {}
        : { lastError: this.lastError ?? connection.lastError }),
    };
  }

  /** Forwards a deliberate core resume to CoreConnection. */
  resume(): void {
    try {
      this.connection.resume();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Local live addresses for TaskStore pruning, or undefined while the connection is not live. */
  liveTerminals(): ReadonlySet<string> | undefined {
    if (!this.connectionIsLive()) return undefined;
    return new Set(
      [...this.tracked.values()]
        .filter(
          (tracked) =>
            tracked.present &&
            tracked.view !== undefined &&
            isLocalAddress(tracked.address) &&
            tracked.view.state === "live" &&
            tracked.view.reason == null,
        )
        .map((tracked) => tracked.address),
    );
  }

  onTransition(sink: TaskTransitionSink): () => void {
    this.transitionSinks.add(sink);
    return () => this.transitionSinks.delete(sink);
  }

  /** Callback target for CoreConnection's first or missed snapshot. */
  onSnapshot(snapshot: EventSnapshot): void {
    if (!this.started) return;
    try {
      this.hasSnapshot = true;
      const now = this.clock.now();
      const found = new Set<string>();
      let changed = false;
      for (const terminal of snapshot.terminals) {
        if (!isLocalAddress(terminal.address)) continue;
        found.add(terminal.address);
        changed =
          this.applyInput(terminal.address, { type: "seen", terminal, now }, "silent") || changed;
      }
      for (const [address, tracked] of [...this.tracked]) {
        if (tracked.present && !found.has(address)) {
          changed = this.applyInput(address, { type: "missing", now }, "silent") || changed;
        }
      }
      this.dropUntrackedMissing();
      this.queueRefresh();
      if (changed) this.resumeFlushAfterChange();
      this.requestReconcile();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Callback target for ordered CoreConnection events. */
  onEvent(event: HcEvent): void {
    if (!this.started) return;
    try {
      if (event.type === "missed" && isObject(event.data) && Array.isArray(event.data.terminals)) {
        this.onSnapshot({
          seq: typeof event.data.seq === "number" ? event.data.seq : event.seq,
          terminals: event.data.terminals as unknown as Terminal[],
        });
        return;
      }

      const address = this.eventTerminalAddress(event);
      if (address === undefined || !isLocalAddress(address)) return;
      const now = this.clock.now();
      const addressedEvent = event.terminal === undefined ? { ...event, terminal: address } : event;
      const table = this.terminalTable();
      const updated = applyEvent(table, addressedEvent, now)[address];
      const hasEmbeddedRecord =
        addressedEvent.type === "labels" &&
        isObject(addressedEvent.data) &&
        addressedEvent.data.record !== undefined;
      let changed: boolean;
      if (
        updated !== undefined &&
        (addressedEvent.type === "created" ||
          addressedEvent.type === "restarted" ||
          hasEmbeddedRecord)
      ) {
        changed = this.applyInput(address, { type: "seen", terminal: updated, now }, "event");
      } else {
        changed = this.applyInput(address, { type: "event", event: addressedEvent, now }, "event");
      }
      if (changed) this.resumeFlushAfterChange();
      this.requestReconcile();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** CoreConnection state callback; a live transition retries flushes and matching. */
  onConnectionState(status: CoreConnectionStatus): void {
    this.connectionStatus = status;
    if (status.state === "live" && this.hasSnapshot) {
      this.scheduleFlush();
      this.requestReconcile();
    }
  }

  private applyInput(
    address: string,
    input: Parameters<typeof reduce>[1],
    source: MarkSource,
  ): boolean {
    const existing = this.tracked.get(address);
    const current = existing ?? { address, present: false };
    const marked = mark(reduce(current, input), source);
    this.tracked.set(address, marked.tracked);
    if (marked.transition !== undefined && marked.tracked.view !== undefined) {
      this.emitTransition(address, marked.tracked, marked.transition);
    }
    this.reconcileSummaryEffects(address, marked.tracked);
    this.scheduleFlush();
    const changed =
      existing === undefined || JSON.stringify(current) !== JSON.stringify(marked.tracked);
    if (changed) {
      this.tasksFullDrop = false;
      if (this.flushPaused && !this.flushInFlight) this.resumeFlushAfterChange();
    }
    return changed;
  }

  private emitTransition(
    address: string,
    tracked: Tracked,
    transition: NonNullable<ReturnType<typeof classOf>>,
  ): void {
    const terminal = tracked.view;
    if (terminal === undefined) return;
    const status =
      tracked.lastStatus?.turn === transition.turn ? tracked.lastStatus.status : undefined;
    const payload: TaskTransition = {
      kind: transition.kind,
      at: this.clock.now(),
      address,
      terminal,
      ...(tracked.record === undefined ? {} : { record: tracked.record }),
      turn: transition.turn,
      ...(transition.kind === "needs-you"
        ? { question: status?.msg ?? status?.title }
        : transition.kind === "done" && status?.msg !== undefined
          ? oneLine(status.msg) === undefined
            ? {}
            : { summary: oneLine(status.msg) }
          : {}),
    };
    try {
      this.logger.info("Task transition", {
        kind: transition.kind,
        address,
        ...(tracked.record === undefined ? {} : { task: tracked.record.id }),
        turn: transition.turn,
      });
    } catch {
      // Logging cannot prevent transition delivery.
    }
    for (const sink of this.transitionSinks) {
      try {
        sink(payload);
      } catch {
        this.logError("transition_sink");
      }
    }
  }

  private queueRefresh(): void {
    const next = this.refreshTail
      .catch(() => {})
      .then(async () => {
        if (!this.started) return;
        try {
          await this.store.refresh();
          this.lastError = undefined;
        } catch (error) {
          this.reportError(error);
        }
        if (!this.started) return;
        const changed = this.syncRecords();
        if (changed) this.resumeFlushAfterChange();
        if (this.hasSnapshot) this.requestReconcile();
      });
    this.refreshTail = next.catch((error: unknown) => this.reportError(error));
  }

  private syncRecords(): boolean {
    const byAddress = new Map<string, TaskRecord>();
    for (const record of Object.values(this.store.snapshot().tasks)) {
      if (record.terminal === undefined || !isLocalAddress(record.terminal)) continue;
      byAddress.set(record.terminal, record);
    }
    const now = this.clock.now();
    let changed = false;
    for (const [address, record] of byAddress) {
      changed = this.applyInput(address, { type: "record", record, now }, "silent") || changed;
    }
    for (const [address, tracked] of [...this.tracked]) {
      if (tracked.record !== undefined && !byAddress.has(address)) {
        changed =
          this.applyInput(address, { type: "record", record: undefined, now }, "silent") || changed;
      }
    }
    this.dropUntrackedMissing();
    return changed;
  }

  private dropUntrackedMissing(): void {
    for (const [address, tracked] of this.tracked) {
      if (!tracked.present && tracked.record === undefined && tracked.summary === undefined) {
        this.tracked.delete(address);
        const timer = this.summaryTimers.get(address);
        if (timer !== undefined) this.clock.clearTimeout(timer.handle);
        this.summaryTimers.delete(address);
      }
    }
  }

  private requestReconcile(): void {
    if (!this.started || !this.hasSnapshot) return;
    this.reconcileAgain = true;
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    void this.drainReconcile();
  }

  private async drainReconcile(): Promise<void> {
    try {
      while (this.started && this.reconcileAgain) {
        this.reconcileAgain = false;
        await this.reconcileOnce();
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.reconcileInFlight = false;
      if (this.started && this.reconcileAgain) this.requestReconcile();
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (!this.hasSnapshot || !this.connectionIsLive()) return;
    const records = Object.values(this.store.snapshot().tasks);
    const claimed = new Set(
      records
        .map((record) => record.terminal)
        .filter((address): address is string => address !== undefined),
    );
    const candidates = [...this.tracked.values()]
      .filter(
        (tracked) =>
          tracked.present &&
          tracked.view?.state === "live" &&
          tracked.view.reason == null &&
          isLocalAddress(tracked.address),
      )
      .map((tracked) => tracked.view as Terminal);

    for (const record of records) {
      if (
        record.terminal !== undefined ||
        record.run?.kind !== "program" ||
        record.folder === undefined
      ) {
        continue;
      }
      const terminal = matchTerminal(
        candidates.filter((candidate) => !claimed.has(candidate.address)),
        {
          program: record.run.id,
          folder: record.folder,
          ...(record.space?.id === undefined ? {} : { spaceId: record.space.id }),
        },
        record.createdAt,
      );
      if (terminal === undefined) continue;
      claimed.add(terminal.address);
      try {
        await this.store.link(record.id, terminal.address);
      } catch (error) {
        if (error instanceof TaskStoreError && error.code === "task_linked") continue;
        this.reportError(error);
      }
    }

    this.syncRecords();
    this.scheduleFlush();
  }

  private terminalTable(): Record<string, Terminal> {
    const table: Record<string, Terminal> = {};
    for (const tracked of this.tracked.values()) {
      if (tracked.present && tracked.view !== undefined) table[tracked.address] = tracked.view;
    }
    return table;
  }

  private pendingOutcomes(): Array<{ address: string; id: string; outcome: TaskOutcome }> {
    if (!this.started || !this.hasSnapshot || this.tasksFullDrop) return [];
    const now = this.clock.now();
    const pending: Array<{ address: string; id: string; outcome: TaskOutcome }> = [];
    for (const tracked of this.tracked.values()) {
      if (tracked.record === undefined || !isLocalAddress(tracked.address)) continue;
      const desired = desiredOutcome(tracked, now);
      if (
        desired.pending ||
        desired.outcome === undefined ||
        sameOutcome(desired.outcome, tracked.record.outcome)
      ) {
        continue;
      }
      pending.push({ address: tracked.address, id: tracked.record.id, outcome: desired.outcome });
    }
    return pending;
  }

  private scheduleFlush(): void {
    if (
      !this.started ||
      !this.hasSnapshot ||
      !this.connectionIsLive() ||
      this.pendingOutcomes().length === 0 ||
      this.flushTimer !== undefined ||
      this.retryTimer !== undefined ||
      this.flushInFlight ||
      this.flushPaused
    ) {
      return;
    }
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushDirty();
    }, TASK_WATCHER_WRITE_COALESCE_MS);
  }

  private async flushDirty(): Promise<void> {
    if (
      !this.started ||
      !this.connectionIsLive() ||
      this.flushInFlight ||
      this.pendingOutcomes().length === 0
    ) {
      return;
    }
    const batch = this.pendingOutcomes();
    const changes = Object.fromEntries(batch.map(({ id, outcome }) => [id, outcome]));
    this.flushInFlight = true;
    let succeeded = false;
    try {
      await this.store.recordOutcomes(changes);
      this.lastWriteAt = this.clock.now();
      this.lastError = undefined;
      this.flushRetries = 0;
      this.flushPaused = false;
      succeeded = true;
    } catch (error) {
      this.reportError(error);
      if (error instanceof TaskStoreError && error.code === "conflict") {
        if (this.flushRetries < TASK_WATCHER_MAX_CONFLICT_RETRIES) {
          this.flushRetries += 1;
          this.retryTimer = this.clock.setTimeout(() => {
            this.retryTimer = undefined;
            void this.flushDirty();
          }, TASK_WATCHER_CONFLICT_RETRY_MS);
        } else {
          this.flushPaused = true;
        }
      } else {
        // tasks_full and other failures wait for a fresh input or store change.
        this.flushPaused = true;
        if (error instanceof TaskStoreError && error.code === "tasks_full")
          this.tasksFullDrop = true;
      }
    } finally {
      this.flushInFlight = false;
      this.syncRecords();
      if (succeeded) this.scheduleFlush();
    }
  }

  private resumeFlushAfterChange(): void {
    if (!this.flushPaused) {
      this.scheduleFlush();
      return;
    }
    this.flushPaused = false;
    this.flushRetries = 0;
    this.scheduleFlush();
  }

  private reconcileSummaryEffects(address: string, tracked: Tracked): void {
    if (!this.started || !this.hasSnapshot) return;
    const job = tracked.summary;
    const scheduled = this.summaryTimers.get(address);
    if (job?.phase === "waiting" && job.dueAt !== undefined) {
      if (scheduled?.dueAt !== job.dueAt) {
        if (scheduled !== undefined) this.clock.clearTimeout(scheduled.handle);
        const dueAt = job.dueAt;
        const handle = this.clock.setTimeout(
          () => {
            if (this.summaryTimers.get(address)?.handle !== handle) return;
            this.summaryTimers.delete(address);
            this.applyInput(
              address,
              { type: "summary-due", now: this.clock.now(), token: ++this.nextReadToken },
              "silent",
            );
          },
          Math.max(0, dueAt - this.clock.now()),
        );
        this.summaryTimers.set(address, { dueAt, handle });
      }
    } else if (scheduled !== undefined) {
      this.clock.clearTimeout(scheduled.handle);
      this.summaryTimers.delete(address);
    }

    if (job?.phase === "reading" && job.token !== undefined) {
      const key = `${address}:${job.token}`;
      if (!this.activeReads.has(key) && readAllowed(tracked)) {
        this.activeReads.add(key);
        void this.readSummary(address, job.token, job.deadline, key);
      }
    }
  }

  private async readSummary(
    address: string,
    token: number,
    deadline: number,
    key: string,
  ): Promise<void> {
    let rows: readonly string[] | undefined;
    try {
      const remaining = Math.max(0, deadline - this.clock.now());
      const value = await within(
        "task summary",
        this.connection.call("terminal.read", { terminal: address }),
        remaining,
        this.clock,
        new AbortController().signal,
      );
      rows = rowsFromRead(value);
    } catch {
      rows = undefined;
    }
    if (!this.activeReads.delete(key) || !this.started) return;
    this.applyInput(
      address,
      { type: "summary-read", token, now: this.clock.now(), rows },
      "silent",
    );
  }

  private eventTerminalAddress(event: HcEvent): string | undefined {
    if (event.terminal !== undefined) return event.terminal;
    if (!isObject(event.data)) return undefined;
    const address = event.data.address;
    if (typeof address === "string") return address;
    const embedded = event.data.record;
    return isObject(embedded) && typeof embedded.address === "string"
      ? embedded.address
      : undefined;
  }

  private connectionIsLive(): boolean {
    try {
      return this.connection.status().state === "live";
    } catch {
      return false;
    }
  }

  private clearTimer(kind: "flush" | "retry"): void {
    const handle = kind === "flush" ? this.flushTimer : this.retryTimer;
    if (handle !== undefined) this.clock.clearTimeout(handle);
    if (kind === "flush") this.flushTimer = undefined;
    else this.retryTimer = undefined;
  }

  private reportError(error: unknown): void {
    this.logError(errorCode(error));
  }

  private logError(code: string): void {
    this.lastError = code;
    try {
      this.logger.error("Task watcher error", { code });
    } catch {
      // Logging must not break connection, reconciliation, or sink delivery.
    }
  }
}
