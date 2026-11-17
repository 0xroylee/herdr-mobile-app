import type { EventSnapshot } from "@herdr-mobile/hc-client";
import type {
  HcEvent,
  HcMethod,
  Status,
  TaskOutcome,
  TaskRecord,
  Terminal,
} from "@herdr-mobile/protocol";
import {
  applyEvent,
  applySnapshot,
  getProgram,
  matchTerminal,
  summarize,
} from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";
import type { CoreConnectionStatus } from "./core-connection.ts";
import type { TaskStore } from "./task-store.ts";
import { TaskStoreError } from "./task-store.ts";

export const TASK_WATCHER_WRITE_COALESCE_MS = 300;
export const TASK_WATCHER_COMPLETION_ATTRIBUTION_MS = 500;
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

interface TrackedCompletion {
  generation: number;
  status?: Status;
  message?: string;
  turn: number;
  pending: boolean;
  attributedAt?: number;
  source: "snapshot" | "event" | "exit";
  timer?: unknown;
}

interface TrackedSummaryJob {
  generation: number;
  turn: number;
  deadline: number;
  attempts: number;
  state: "scheduled" | "in-flight" | "ready";
  summary?: string;
  timer?: unknown;
  timeout?: unknown;
  cancelResolve?: () => void;
  cancelled: boolean;
}

interface TrackedTransition {
  kind: TaskTransitionKind;
  turn: number;
}

/** The complete watcher memory for one terminal address. */
export interface TrackedTask {
  address: string;
  /** Last table entry, retained after removal so exit and completion evidence survives. */
  terminal?: Terminal;
  inTable: boolean;
  task?: TaskRecord;
  status: Status | null | undefined;
  statusTurn: number;
  reported: boolean;
  ended: boolean;
  endedAt?: number;
  completion?: TrackedCompletion;
  persistedOutcome?: TaskOutcome;
  eventSinceSnapshot: boolean;
  eventSupersededOutcome: boolean;
  summaryJob?: TrackedSummaryJob;
  pendingWrite?: TaskOutcome;
  lastEmitted?: TrackedTransition;
  createdAt: number;
}

type PersistedSource = "refresh" | "store" | "write";

type ReducerInput =
  | { type: "snapshot"; terminal: Terminal; now: number; generation: number }
  | { type: "snapshot-missing"; now: number; generation: number }
  | {
      type: "event";
      event: HcEvent;
      terminal?: Terminal;
      now: number;
      generation: number;
    }
  | { type: "persisted"; task?: TaskRecord; source: PersistedSource; now: number }
  | { type: "completion-timeout"; generation: number; now: number }
  | { type: "summary-scheduled"; job: TrackedSummaryJob }
  | { type: "summary-started"; generation: number }
  | { type: "summary-retry"; generation: number }
  | { type: "summary-result"; generation: number; summary?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalAddress(address: string): boolean {
  return !address.includes("/");
}

function terminalTurn(terminal: Terminal | undefined): number {
  return terminal?.turn ?? 0;
}

function terminalEnded(terminal: Terminal | undefined): boolean {
  return terminal === undefined || terminal.state === "finished" || terminal.reason != null;
}

function isDoneStatus(status: Status | null | undefined, turn: number): boolean {
  return status?.state === "done" || (status?.state === "idle" && turn >= 1);
}

function eventStatus(event: HcEvent): Status | null | undefined {
  if (event.type !== "status" || !isObject(event.data)) return undefined;
  const status = event.data.status;
  if (status === null) return null;
  return isObject(status) && typeof status.state === "string"
    ? (status as unknown as Status)
    : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof TaskStoreError) return error.code;
  return "watcher_error";
}

function rowsFromRead(value: unknown): string[] | undefined {
  if (!isObject(value) || typeof value.text !== "string") return undefined;
  return value.text.split(/\r?\n/u);
}

function sameOutcome(left: TaskOutcome | undefined, right: TaskOutcome | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.state === right.state &&
    left.turn === right.turn &&
    left.ended === right.ended &&
    left.summary === right.summary &&
    left.exit?.code === right.exit?.code &&
    left.exit?.signal === right.exit?.signal &&
    left.exit?.reason === right.exit?.reason
  );
}

function hasExitDetails(terminal: Terminal | undefined): boolean {
  return (
    terminal !== undefined &&
    (terminal.state === "finished" ||
      terminal.reason != null ||
      terminal.exit_code != null ||
      terminal.signal != null)
  );
}

function currentStatus(tracked: TrackedTask): Status | undefined {
  return tracked.statusTurn === terminalTurn(tracked.terminal)
    ? (tracked.status ?? undefined)
    : undefined;
}

function sameStatus(left: Status | null | undefined, right: Status | null | undefined): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.state === right.state &&
    left.msg === right.msg &&
    left.title === right.title &&
    left.app === right.app
  );
}

function sameTransition(
  left: TrackedTransition | undefined,
  right: TrackedTransition | undefined,
): boolean {
  return left?.kind === right?.kind && left?.turn === right?.turn;
}

function trackedIsEnded(tracked: TrackedTask): boolean {
  return !tracked.inTable || tracked.ended || terminalEnded(tracked.terminal);
}

function persistedDoneIsCurrent(tracked: TrackedTask): boolean {
  const outcome = tracked.persistedOutcome;
  if (outcome?.state !== "done" || tracked.eventSupersededOutcome) return false;
  const status = currentStatus(tracked);
  if (status !== undefined && !isDoneStatus(status, terminalTurn(tracked.terminal))) return false;
  if (tracked.terminal === undefined || !tracked.inTable) return true;
  return outcome.turn === terminalTurn(tracked.terminal);
}

function doneTurn(tracked: TrackedTask): number | undefined {
  const turn = terminalTurn(tracked.terminal);
  const ended = trackedIsEnded(tracked);
  const completion = tracked.completion;
  if (completion?.pending) return undefined;
  if (completion !== undefined && (tracked.terminal === undefined || completion.turn === turn)) {
    return completion.turn;
  }

  const status = currentStatus(tracked);
  if (isDoneStatus(status, turn)) return turn;

  if (ended && tracked.terminal?.exit_code === 0 && turn >= 1) return turn;
  if (persistedDoneIsCurrent(tracked)) return tracked.persistedOutcome?.turn;
  return undefined;
}

function eligibleForTransition(tracked: TrackedTask): boolean {
  return (
    tracked.task !== undefined ||
    ((tracked.terminal !== undefined || tracked.inTable) &&
      (tracked.reported || tracked.status != null))
  );
}

/** Pure transition derivation. The turn and kind are the complete dedupe key. */
export function transitionOf(tracked: TrackedTask): TrackedTransition | undefined {
  if (!isLocalAddress(tracked.address) || !eligibleForTransition(tracked)) return undefined;
  const completion = tracked.completion;
  if (completion?.pending) return undefined;

  const completed = doneTurn(tracked);
  if (completed !== undefined) return { kind: "done", turn: completed };

  const ended = trackedIsEnded(tracked);
  const status = currentStatus(tracked);
  if (!ended && (status?.state === "blocked" || status?.state === "error")) {
    return { kind: "needs-you", turn: terminalTurn(tracked.terminal) };
  }
  if (ended) return { kind: "stopped", turn: terminalTurn(tracked.terminal) };
  return undefined;
}

function statusSummary(tracked: TrackedTask, status: Status | undefined): string | undefined {
  if (status === undefined) return undefined;
  const programKey = tracked.terminal === undefined ? "bot" : getProgram(tracked.terminal).iconKey;
  return summarize(programKey, status, []);
}

function outcomeTime(tracked: TrackedTask, turn: number, ended: boolean): number {
  const completion = tracked.completion;
  if (completion?.turn === turn && completion.attributedAt !== undefined) {
    return completion.attributedAt;
  }
  if (ended && tracked.endedAt !== undefined) return tracked.endedAt;
  const persisted = tracked.persistedOutcome;
  if (persisted?.turn === turn && persisted.ended === ended) return persisted.at;
  return tracked.createdAt;
}

function outcomeExit(terminal: Terminal | undefined): TaskOutcome["exit"] | undefined {
  if (terminal === undefined || !hasExitDetails(terminal)) return undefined;
  return {
    code: terminal.exit_code ?? null,
    signal: terminal.signal ?? null,
    reason: terminal.reason ?? null,
  };
}

/** Pure outcome derivation. A pending summary job deliberately withholds Done until it settles. */
export function desiredOutcome(tracked: TrackedTask): TaskOutcome | undefined {
  const transition = transitionOf(tracked);
  if (transition === undefined || transition.kind === "needs-you") return undefined;

  const ended = trackedIsEnded(tracked);
  const turn = transition.turn;
  const persisted = tracked.persistedOutcome;
  const completion = tracked.completion;

  if (transition.kind === "stopped") {
    const candidate: TaskOutcome = {
      state: "stopped",
      turn,
      ended: true,
      at: outcomeTime(tracked, turn, true),
      ...(outcomeExit(tracked.terminal) === undefined
        ? {}
        : { exit: outcomeExit(tracked.terminal) }),
    };
    if (persisted?.state === "stopped" && sameOutcome(persisted, candidate)) return persisted;
    return candidate;
  }

  const completionStatus = completion?.turn === turn ? completion.status : undefined;
  const visibleStatus = currentStatus(tracked);
  const sourceStatus =
    completionStatus ?? (isDoneStatus(visibleStatus, turn) ? visibleStatus : undefined);
  const messageSummary =
    completion?.turn === turn && completion.message !== undefined
      ? statusSummary(tracked, completion.status ?? { state: "done", msg: completion.message })
      : statusSummary(tracked, sourceStatus);
  const persistedSummaryIsUsable =
    persisted?.state === "done" && persisted.turn === turn && !tracked.eventSupersededOutcome;
  const persistedOutcomeIsSettled = persistedSummaryIsUsable && persisted?.ended === ended;
  const keptShell =
    tracked.terminal !== undefined &&
    tracked.inTable &&
    ((tracked.terminal.state === "live" && tracked.terminal.reason != null) ||
      (tracked.ended && tracked.terminal.state === "live"));
  const job = tracked.summaryJob?.turn === turn ? tracked.summaryJob : undefined;

  let summary: string | undefined;
  if (keptShell && completion?.source === "snapshot" && persistedSummaryIsUsable) {
    summary = persisted?.summary;
  } else if (messageSummary !== undefined) {
    summary = messageSummary;
  } else if (persistedOutcomeIsSettled) {
    summary = persisted?.summary;
  } else if (job?.state === "ready") {
    summary = job.summary ?? (persistedSummaryIsUsable ? persisted?.summary : undefined);
  } else if (job !== undefined) {
    return undefined;
  } else if (canReadSummary(tracked)) {
    return undefined;
  } else if (persistedSummaryIsUsable) {
    summary = persisted?.summary;
  }

  const candidate: TaskOutcome = {
    state: "done",
    turn,
    ended,
    at: outcomeTime(tracked, turn, ended),
    ...(summary === undefined ? {} : { summary }),
  };
  if (persisted?.state === "done" && sameOutcome(persisted, candidate)) return persisted;
  return candidate;
}

function canReadSummary(tracked: TrackedTask): boolean {
  return (
    tracked.task !== undefined &&
    tracked.terminal !== undefined &&
    tracked.inTable &&
    !(tracked.terminal.state === "live" && tracked.terminal.reason != null) &&
    !(tracked.ended && tracked.terminal.state === "live")
  );
}

function makeTracked(address: string, now: number): TrackedTask {
  return {
    address,
    inTable: false,
    status: undefined,
    statusTurn: 0,
    reported: false,
    ended: false,
    eventSinceSnapshot: false,
    eventSupersededOutcome: false,
    createdAt: now,
  };
}

function completionFromStatus(
  status: Status,
  turn: number,
  pending: boolean,
  source: TrackedCompletion["source"],
  generation: number,
  now: number,
): TrackedCompletion {
  return {
    generation,
    status,
    ...(typeof status.msg === "string" ? { message: status.msg } : {}),
    turn,
    pending,
    ...(pending ? {} : { attributedAt: now }),
    source,
  };
}

function completionFromExit(turn: number, generation: number, now: number): TrackedCompletion {
  return {
    generation,
    turn,
    pending: false,
    attributedAt: now,
    source: "exit",
  };
}

function applyTerminalObservation(
  tracked: TrackedTask,
  terminal: Terminal,
  now: number,
  generation: number,
  source: "snapshot" | "event",
): void {
  const previousCompletion = tracked.completion;
  const turn = terminalTurn(terminal);
  const status = terminal.status ?? undefined;
  const wasWorkingThisTurn = tracked.status?.state === "working" && tracked.statusTurn === turn;

  tracked.terminal = terminal;
  tracked.inTable = true;
  tracked.status = terminal.status;
  tracked.statusTurn = turn;
  tracked.reported = terminal.reported === true || terminal.status != null;
  tracked.ended = terminalEnded(terminal);
  tracked.endedAt = tracked.ended ? (tracked.endedAt ?? now) : undefined;

  if (status !== undefined && isDoneStatus(status, turn)) {
    const priorMatches =
      previousCompletion !== undefined &&
      (previousCompletion.pending || previousCompletion.turn === turn);
    const prior = priorMatches ? previousCompletion : undefined;
    const keepPending = prior?.pending === true && prior.turn === turn;
    tracked.completion = {
      ...(prior ?? completionFromStatus(status, turn, false, source, generation, now)),
      generation: prior?.generation ?? generation,
      status: prior?.status ?? status,
      ...(prior?.message === undefined && typeof status.msg === "string"
        ? { message: status.msg }
        : prior?.message === undefined
          ? {}
          : { message: prior.message }),
      turn,
      pending: keepPending,
      ...(keepPending ? {} : { attributedAt: prior?.attributedAt ?? now }),
      source: prior?.source ?? source,
      timer: keepPending ? prior?.timer : undefined,
    };
  } else if (previousCompletion?.pending && tracked.ended) {
    tracked.completion = {
      ...previousCompletion,
      turn,
      pending: false,
      attributedAt: now,
      timer: undefined,
    };
  } else if (
    status?.state === "working" ||
    status?.state === "blocked" ||
    status?.state === "error" ||
    (previousCompletion !== undefined && previousCompletion.turn !== turn)
  ) {
    tracked.completion = undefined;
  }

  if (status !== undefined && !isDoneStatus(status, turn)) tracked.eventSupersededOutcome = true;
  else tracked.eventSupersededOutcome = false;

  if (tracked.terminal.state === "live" && tracked.terminal.reason != null) {
    tracked.ended = true;
    tracked.endedAt ??= now;
    if (tracked.completion?.pending) {
      tracked.completion = {
        ...tracked.completion,
        turn,
        pending: false,
        attributedAt: now,
        timer: undefined,
      };
    }
  }

  if (status !== undefined && isDoneStatus(status, turn) && wasWorkingThisTurn && !tracked.ended) {
    tracked.completion = completionFromStatus(status, turn, true, source, generation, now);
  }

  if (tracked.ended && terminal.exit_code === 0 && turn >= 1 && tracked.completion === undefined) {
    tracked.completion = completionFromExit(turn, generation, now);
  }
}

/** The single state reducer for snapshots, events, persisted data, reads, and timers. */
function reduce(tracked: TrackedTask, input: ReducerInput): TrackedTask {
  switch (input.type) {
    case "snapshot": {
      const oldStatus = tracked.status;
      const oldTurn = terminalTurn(tracked.terminal);
      tracked.eventSinceSnapshot = false;
      applyTerminalObservation(tracked, input.terminal, input.now, input.generation, "snapshot");
      if (
        oldTurn !== terminalTurn(input.terminal) ||
        !sameStatus(oldStatus, input.terminal.status) ||
        (input.terminal.state === "live" && input.terminal.reason != null)
      ) {
        tracked.summaryJob = undefined;
      }
      const snapshotStatus = currentStatus(tracked);
      tracked.eventSupersededOutcome =
        snapshotStatus !== undefined && !isDoneStatus(snapshotStatus, terminalTurn(input.terminal));
      if (tracked.ended && tracked.completion?.pending) {
        tracked.completion = {
          ...tracked.completion,
          pending: false,
          turn: terminalTurn(tracked.terminal),
          attributedAt: input.now,
          timer: undefined,
        };
      }
      return tracked;
    }
    case "snapshot-missing": {
      tracked.inTable = false;
      tracked.eventSinceSnapshot = false;
      tracked.ended = true;
      tracked.endedAt ??= input.now;
      if (tracked.completion?.pending) {
        tracked.completion.pending = false;
        tracked.completion.turn = terminalTurn(tracked.terminal);
        tracked.completion.attributedAt = input.now;
        tracked.completion.timer = undefined;
      }
      tracked.summaryJob = undefined;
      if (
        tracked.terminal?.exit_code === 0 &&
        terminalTurn(tracked.terminal) >= 1 &&
        tracked.completion === undefined
      ) {
        tracked.completion = completionFromExit(
          terminalTurn(tracked.terminal),
          input.generation,
          input.now,
        );
      }
      return tracked;
    }
    case "event": {
      const { event, terminal, now, generation } = input;
      tracked.eventSinceSnapshot = true;
      const oldTurn = terminalTurn(tracked.terminal);
      const oldStatus = currentStatus(tracked);
      const type = event.type;

      if (type === "created" || type === "restarted") {
        if (terminal !== undefined)
          applyTerminalObservation(tracked, terminal, now, generation, "event");
        tracked.completion = undefined;
        tracked.summaryJob = undefined;
        tracked.eventSupersededOutcome = true;
        tracked.ended = terminal === undefined ? false : terminalEnded(terminal);
        tracked.endedAt = tracked.ended ? now : undefined;
        return tracked;
      }

      if (terminal !== undefined) {
        tracked.terminal = terminal;
        tracked.inTable = true;
        tracked.reported = terminal.reported === true || tracked.reported;
      }

      if (type === "status") {
        const status = eventStatus(event);
        const nextTurn = terminalTurn(terminal ?? tracked.terminal);
        const wasWorkingThisTurn =
          oldStatus?.state === "working" && tracked.statusTurn === nextTurn;
        tracked.status = status;
        tracked.statusTurn = nextTurn;
        tracked.reported =
          (isObject(event.data) && event.data.reported === true) ||
          status != null ||
          tracked.reported;
        tracked.ended =
          tracked.terminal === undefined ? tracked.ended : terminalEnded(tracked.terminal);
        tracked.eventSupersededOutcome = true;
        tracked.summaryJob = undefined;
        if (status !== undefined && status !== null && isDoneStatus(status, nextTurn)) {
          const pending = wasWorkingThisTurn && !tracked.ended;
          tracked.completion = completionFromStatus(
            status,
            nextTurn,
            pending,
            "event",
            generation,
            now,
          );
        } else {
          tracked.completion = undefined;
        }
        if (tracked.ended && tracked.completion?.pending) {
          tracked.completion.pending = false;
          tracked.completion.turn = nextTurn;
          tracked.completion.attributedAt = now;
        }
        return tracked;
      }

      if (type === "turn") {
        const nextTurn = terminalTurn(terminal ?? tracked.terminal);
        if (nextTurn !== oldTurn) tracked.eventSupersededOutcome = true;
        tracked.summaryJob =
          tracked.summaryJob !== undefined && tracked.summaryJob.turn !== nextTurn
            ? undefined
            : tracked.summaryJob;
        if (tracked.completion?.pending) {
          tracked.completion = {
            ...tracked.completion,
            turn: nextTurn,
            pending: false,
            attributedAt: now,
            timer: undefined,
          };
          tracked.statusTurn = nextTurn;
        } else if (tracked.completion !== undefined && tracked.completion.turn !== nextTurn) {
          tracked.completion = undefined;
        }
        return tracked;
      }

      if (type === "finished" || type === "lost") {
        tracked.ended = true;
        tracked.endedAt ??= now;
        if (tracked.completion?.pending) {
          tracked.completion = {
            ...tracked.completion,
            turn: terminalTurn(tracked.terminal),
            pending: false,
            attributedAt: now,
            timer: undefined,
          };
        }
        if (
          tracked.terminal?.exit_code === 0 &&
          terminalTurn(tracked.terminal) >= 1 &&
          tracked.completion === undefined
        ) {
          tracked.completion = completionFromExit(terminalTurn(tracked.terminal), generation, now);
        }
        if (
          type === "lost" ||
          (tracked.terminal?.state === "live" && tracked.terminal.reason != null)
        ) {
          tracked.summaryJob = undefined;
        }
        return tracked;
      }

      if (type === "removed") {
        tracked.inTable = false;
        tracked.ended = true;
        tracked.endedAt ??= now;
        tracked.summaryJob = undefined;
        if (tracked.completion?.pending) {
          tracked.completion = {
            ...tracked.completion,
            turn: terminalTurn(tracked.terminal),
            pending: false,
            attributedAt: now,
            timer: undefined,
          };
        }
        if (
          tracked.terminal?.exit_code === 0 &&
          terminalTurn(tracked.terminal) >= 1 &&
          tracked.completion === undefined
        ) {
          tracked.completion = completionFromExit(terminalTurn(tracked.terminal), generation, now);
        }
        return tracked;
      }

      // A labels event may be the first full terminal record for this address.
      if (terminal !== undefined && tracked.statusTurn === 0 && tracked.status === undefined) {
        applyTerminalObservation(tracked, terminal, now, generation, "event");
      }
      return tracked;
    }
    case "persisted": {
      const previousTransition = transitionOf(tracked);
      tracked.task = input.task;
      tracked.persistedOutcome = input.task?.outcome;
      if (input.source === "refresh") {
        if (!tracked.eventSinceSnapshot) {
          const status = currentStatus(tracked);
          tracked.eventSupersededOutcome =
            status !== undefined && !isDoneStatus(status, terminalTurn(tracked.terminal));
          const refreshedTransition = transitionOf(tracked);
          if (
            !sameTransition(previousTransition, refreshedTransition) &&
            refreshedTransition !== undefined
          ) {
            tracked.lastEmitted = refreshedTransition;
          }
        } else {
          tracked.eventSupersededOutcome = true;
        }
      } else if (input.source === "write") {
        tracked.eventSupersededOutcome = false;
      }
      return tracked;
    }
    case "completion-timeout": {
      const completion = tracked.completion;
      if (completion?.generation === input.generation && completion.pending) {
        completion.turn = terminalTurn(tracked.terminal);
        completion.pending = false;
        completion.attributedAt = input.now;
        completion.timer = undefined;
      }
      return tracked;
    }
    case "summary-scheduled":
      tracked.summaryJob = input.job;
      return tracked;
    case "summary-started": {
      const job = tracked.summaryJob;
      if (job?.generation === input.generation && !job.cancelled) {
        job.state = "in-flight";
        job.attempts += 1;
        job.timer = undefined;
      }
      return tracked;
    }
    case "summary-retry": {
      const job = tracked.summaryJob;
      if (job?.generation === input.generation && !job.cancelled) {
        job.state = "scheduled";
        job.timer = undefined;
        job.timeout = undefined;
        job.cancelResolve = undefined;
      }
      return tracked;
    }
    case "summary-result": {
      const job = tracked.summaryJob;
      if (job?.generation === input.generation && !job.cancelled) {
        job.state = "ready";
        job.summary = input.summary;
        job.timer = undefined;
        job.timeout = undefined;
        job.cancelResolve = undefined;
      }
      return tracked;
    }
  }
}

/** Keeps task outcomes and transition signals aligned with the current core terminal table. */
export class TaskWatcher {
  private readonly connection: TaskWatcherConnection;
  private readonly store: TaskStore;
  private readonly clock: Clock;
  private readonly logger: TaskWatcherLogger;
  private readonly transitionSinks = new Set<TaskTransitionSink>();
  /** This is the only per-terminal state collection. */
  private readonly tracked = new Map<string, TrackedTask>();
  private started = false;
  private hasSnapshot = false;
  private generation = 0;
  private pendingRefreshes = 0;
  private reconciling = false;
  private reconcileAgain = false;
  private refreshTail: Promise<void> = Promise.resolve();
  private unsubscribeStore: (() => void) | undefined;
  private flushTimer: unknown;
  private retryTimer: unknown;
  private flushInFlight = false;
  private flushRetries = 0;
  private flushPaused = false;
  private lastWriteAt: number | undefined;
  private lastError: string | undefined;
  private connectionStatus: CoreConnectionStatus | undefined;

  constructor(dependencies: TaskWatcherDependencies) {
    this.connection = dependencies.connection;
    this.store = dependencies.store;
    this.clock = dependencies.clock ?? systemClock;
    this.logger = dependencies.logger;
  }

  /** Starts the connection and queues the initial document refresh without waiting for either. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeStore = this.store.onChange(() => {
      if (this.pendingRefreshes > 0) return;
      this.syncRecords("store");
      if (!this.flushInFlight) this.resumeFlushAfterChange();
      this.requestReconcile();
    });
    try {
      this.connection.start();
    } catch (error) {
      this.reportError(error);
    }
    this.queueRefreshAndReconcile();
  }

  /** Stops timers and listeners, then stops the long-lived core connection. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.clearTimer("flush");
    this.clearTimer("retry");
    for (const tracked of this.tracked.values()) {
      if (tracked.completion?.timer !== undefined)
        this.clock.clearTimeout(tracked.completion.timer);
      tracked.completion = tracked.completion
        ? { ...tracked.completion, timer: undefined }
        : undefined;
      if (tracked.summaryJob) this.cancelSummaryJob(tracked.summaryJob);
      tracked.summaryJob = undefined;
      tracked.pendingWrite = undefined;
    }
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
      terminals: [...this.tracked.values()].filter((tracked) => tracked.inTable).length,
      tracked: records.filter((record) => {
        if (record.terminal === undefined || !isLocalAddress(record.terminal)) return false;
        return this.tracked.get(record.terminal)?.inTable === true;
      }).length,
      pendingWrites: [...this.tracked.values()].filter(
        (tracked) => tracked.pendingWrite !== undefined,
      ).length,
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
    try {
      if (this.connection.status().state !== "live") return undefined;
    } catch {
      return undefined;
    }
    return new Set(
      [...this.tracked.values()]
        .filter(
          (tracked) =>
            tracked.inTable &&
            tracked.terminal !== undefined &&
            isLocalAddress(tracked.address) &&
            tracked.terminal.state === "live" &&
            tracked.terminal.reason == null &&
            !tracked.ended,
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
      // Gate outcome writes and screen reads until persisted restart memory has joined the records.
      this.queueRefreshAndReconcile();
      const table = applySnapshot(snapshot);
      const now = this.clock.now();
      const addresses = new Set(Object.keys(table));

      for (const address of this.tracked.keys()) {
        const terminal = table[address];
        this.dispatch(
          address,
          terminal === undefined
            ? { type: "snapshot-missing", now, generation: ++this.generation }
            : { type: "snapshot", terminal, now, generation: ++this.generation },
          { seedIfNew: false, emit: false },
        );
      }
      for (const terminal of Object.values(table)) {
        if (this.tracked.has(terminal.address)) continue;
        this.dispatch(
          terminal.address,
          { type: "snapshot", terminal, now, generation: ++this.generation },
          { seedIfNew: true, emit: false },
        );
      }
      // Addresses removed by this snapshot are records too; preserve their terminal and hook memory.
      for (const tracked of this.tracked.values()) {
        if (!addresses.has(tracked.address) && tracked.inTable) {
          this.dispatch(
            tracked.address,
            { type: "snapshot-missing", now, generation: ++this.generation },
            { emit: false },
          );
        }
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Callback target for ordered CoreConnection events. */
  onEvent(event: HcEvent): void {
    if (!this.started) return;
    try {
      if (event.type === "missed" && isObject(event.data) && Array.isArray(event.data.terminals)) {
        const snapshot: EventSnapshot = {
          seq: typeof event.data.seq === "number" ? event.data.seq : event.seq,
          terminals: event.data.terminals as unknown as Terminal[],
        };
        this.onSnapshot(snapshot);
        return;
      }

      const now = this.clock.now();
      const address = event.terminal ?? this.eventTerminalAddress(event);
      if (address === undefined) return;
      const previous = this.tracked.get(address);
      const table = applyEvent(this.currentTerminalTable(), event, now);
      const eventAddress =
        event.type === "created" || event.type === "restarted"
          ? (this.eventTerminalAddress(event) ?? address)
          : address;
      const resultingTerminal = table[eventAddress];
      const latestTerminal =
        resultingTerminal ?? (event.type === "removed" ? previous?.terminal : undefined);
      if (previous === undefined && latestTerminal === undefined) return;

      const known = previous ?? makeTracked(eventAddress, now);
      if (previous === undefined) this.tracked.set(eventAddress, known);
      this.dispatch(
        eventAddress,
        {
          type: "event",
          event,
          ...(latestTerminal === undefined ? {} : { terminal: latestTerminal }),
          now,
          generation: ++this.generation,
        },
        { emit: true },
      );
      this.resumeFlushAfterChange();
      this.requestReconcile();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** CoreConnection state callback; the status method remains the source of the current state. */
  onConnectionState(status: CoreConnectionStatus): void {
    this.connectionStatus = status;
    if (status.state === "live" && this.hasSnapshot) this.requestReconcile();
  }

  private dispatch(
    address: string,
    input: ReducerInput,
    options: { emit?: boolean; seedIfNew?: boolean } = {},
  ): void {
    let tracked = this.tracked.get(address);
    const isNew = tracked === undefined;
    const now = "now" in input ? input.now : this.clock.now();
    if (tracked === undefined) tracked = makeTracked(address, now);
    const wasInTable = tracked.inTable;
    const oldCompletion = tracked.completion;
    const oldCompletionWasPending = oldCompletion?.pending === true;
    const oldSummaryJob = tracked.summaryJob;

    reduce(tracked, input);
    this.tracked.set(address, tracked);

    if (
      oldCompletion?.timer !== undefined &&
      (tracked.completion !== oldCompletion ||
        (oldCompletionWasPending && tracked.completion?.pending !== true)) &&
      tracked.completion?.timer !== oldCompletion.timer
    ) {
      this.clock.clearTimeout(oldCompletion.timer);
      if (tracked.completion === oldCompletion) oldCompletion.timer = undefined;
    }
    if (oldSummaryJob !== undefined && oldSummaryJob !== tracked.summaryJob) {
      this.cancelSummaryJob(oldSummaryJob);
    }

    if (options.seedIfNew && isNew) tracked.lastEmitted = transitionOf(tracked);
    else if (input.type === "snapshot" && !wasInTable && tracked.inTable) {
      tracked.lastEmitted = transitionOf(tracked);
    }

    this.scheduleCompletionAttribution(tracked);
    this.scheduleSummaryIfNeeded(tracked);
    if (options.emit) this.emitChangedTransition(tracked);
    this.deriveWrite(tracked);
  }

  private scheduleCompletionAttribution(tracked: TrackedTask): void {
    const completion = tracked.completion;
    if (completion === undefined || !completion.pending || completion.timer !== undefined) return;
    const generation = completion.generation;
    completion.timer = this.clock.setTimeout(() => {
      const current = this.tracked.get(tracked.address);
      if (current?.completion !== completion) return;
      completion.timer = undefined;
      this.dispatch(
        tracked.address,
        { type: "completion-timeout", generation, now: this.clock.now() },
        { emit: true },
      );
    }, TASK_WATCHER_COMPLETION_ATTRIBUTION_MS);
  }

  private scheduleSummaryIfNeeded(tracked: TrackedTask): void {
    if (!this.started || this.pendingRefreshes > 0 || !this.hasSnapshot) return;
    if (!needsSummaryRead(tracked)) return;
    const completion = tracked.completion;
    const transition = transitionOf(tracked);
    if (completion === undefined || transition?.kind !== "done") return;
    const now = this.clock.now();
    const job: TrackedSummaryJob = {
      generation: ++this.generation,
      turn: transition.turn,
      deadline: (completion.attributedAt ?? now) + TASK_WATCHER_SUMMARY_CAP_MS,
      attempts: 0,
      state: "scheduled",
      cancelled: false,
    };
    this.dispatch(tracked.address, { type: "summary-scheduled", job }, { emit: false });
    const active = this.tracked.get(tracked.address)?.summaryJob;
    if (active === job) {
      this.scheduleSummaryTimer(
        tracked.address,
        job,
        Math.min(TASK_WATCHER_SUMMARY_DELAY_MS, Math.max(0, job.deadline - now)),
      );
    }
  }

  private deriveWrite(tracked: TrackedTask): void {
    if (
      !this.started ||
      !this.hasSnapshot ||
      this.pendingRefreshes > 0 ||
      tracked.task === undefined ||
      !isLocalAddress(tracked.address)
    ) {
      return;
    }
    const outcome = desiredOutcome(tracked);
    if (outcome === undefined || sameOutcome(tracked.persistedOutcome, outcome)) {
      tracked.pendingWrite = undefined;
      return;
    }
    tracked.pendingWrite = outcome;
    this.scheduleFlush();
  }

  private emitChangedTransition(tracked: TrackedTask): void {
    const next = transitionOf(tracked);
    if (next === undefined) return;
    const previous = tracked.lastEmitted;
    if (previous?.kind === next.kind && previous.turn === next.turn) return;
    tracked.lastEmitted = next;
    const terminal = tracked.terminal;
    if (terminal === undefined) return;
    const status = currentStatus(tracked);
    const transition: TaskTransition = {
      kind: next.kind,
      at: this.clock.now(),
      address: tracked.address,
      terminal,
      ...(tracked.task === undefined ? {} : { record: tracked.task }),
      turn: next.turn,
      ...(next.kind === "needs-you"
        ? { question: status?.msg ?? status?.title }
        : next.kind === "done" && typeof (tracked.completion?.message ?? status?.msg) === "string"
          ? { summary: tracked.completion?.message ?? status?.msg }
          : {}),
    };
    try {
      this.logger.info("Task transition", {
        kind: next.kind,
        address: tracked.address,
        ...(tracked.task === undefined ? {} : { task: tracked.task.id }),
        turn: next.turn,
      });
    } catch {
      // Logging cannot prevent transition delivery.
    }
    for (const sink of this.transitionSinks) {
      try {
        sink(transition);
      } catch {
        this.logError("transition_sink");
      }
    }
  }

  private queueRefreshAndReconcile(): void {
    this.pendingRefreshes += 1;
    const next = this.refreshTail
      .catch(() => {})
      .then(async () => {
        try {
          if (!this.started) return;
          try {
            await this.store.refresh();
            this.lastError = undefined;
          } catch (error) {
            this.reportError(error);
          }
        } finally {
          this.pendingRefreshes -= 1;
        }
        if (!this.started) return;
        this.syncRecords("refresh");
        if (this.hasSnapshot) this.requestReconcile();
      });
    this.refreshTail = next.catch((error: unknown) => this.reportError(error));
  }

  private syncRecords(source: PersistedSource): void {
    const records = Object.values(this.store.snapshot().tasks);
    const byAddress = new Map<string, TaskRecord>();
    for (const record of records) {
      if (record.terminal === undefined || !isLocalAddress(record.terminal)) continue;
      byAddress.set(record.terminal, record);
    }
    const now = this.clock.now();
    for (const [address, task] of byAddress) {
      this.dispatch(address, { type: "persisted", task, source, now }, { emit: false });
    }
    for (const tracked of this.tracked.values()) {
      if (tracked.task !== undefined && !byAddress.has(tracked.address)) {
        this.dispatch(tracked.address, { type: "persisted", source, now }, { emit: false });
      }
    }
  }

  private requestReconcile(): void {
    if (!this.started) return;
    this.reconcileAgain = true;
    if (this.reconciling) return;
    this.reconciling = true;
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
      this.reconciling = false;
      if (this.started && this.reconcileAgain) this.requestReconcile();
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (!this.hasSnapshot || this.pendingRefreshes > 0 || !this.connectionIsLive()) return;
    const initial = this.store.snapshot().tasks;
    const claimed = new Set(
      Object.values(initial)
        .map((record) => record.terminal)
        .filter((address): address is string => address !== undefined),
    );
    const local = this.currentTerminalValues().filter((terminal) =>
      isLocalAddress(terminal.address),
    );

    for (const record of Object.values(initial)) {
      if (
        record.terminal !== undefined ||
        record.run?.kind !== "program" ||
        record.folder === undefined
      ) {
        continue;
      }
      const match = matchTerminal(
        local.filter((terminal) => !claimed.has(terminal.address)),
        {
          program: record.run.id,
          folder: record.folder,
          ...(record.space?.id === undefined ? {} : { spaceId: record.space.id }),
        },
        this.clock.now(),
      );
      if (!match) continue;
      claimed.add(match.address);
      try {
        await this.store.link(record.id, match.address);
      } catch (error) {
        if (error instanceof TaskStoreError && error.code === "task_linked") continue;
        this.reportError(error);
      }
    }

    this.syncRecords("store");
    for (const tracked of this.tracked.values()) this.deriveWrite(tracked);
  }

  private currentTerminalTable(): Record<string, Terminal> {
    const table: Record<string, Terminal> = {};
    for (const tracked of this.tracked.values()) {
      if (tracked.inTable && tracked.terminal !== undefined)
        table[tracked.address] = tracked.terminal;
    }
    return table;
  }

  private currentTerminalValues(): Terminal[] {
    return [...this.tracked.values()]
      .filter((tracked) => tracked.inTable && tracked.terminal !== undefined)
      .map((tracked) => tracked.terminal as Terminal);
  }

  private scheduleFlush(): void {
    if (
      !this.started ||
      !this.hasSnapshot ||
      this.pendingRefreshes > 0 ||
      !this.hasPendingWrites() ||
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
      !this.hasPendingWrites()
    ) {
      return;
    }
    const batch = [...this.tracked.values()]
      .filter((tracked) => tracked.task !== undefined && tracked.pendingWrite !== undefined)
      .map((tracked) => ({
        address: tracked.address,
        id: tracked.task?.id as string,
        outcome: tracked.pendingWrite as TaskOutcome,
      }));
    if (batch.length === 0) return;
    const changes = Object.fromEntries(batch.map(({ id, outcome }) => [id, outcome]));
    this.flushInFlight = true;
    let succeeded = false;
    try {
      await this.store.recordOutcomes(changes);
      this.lastWriteAt = this.clock.now();
      this.lastError = undefined;
      succeeded = true;
      const tasks = this.store.snapshot().tasks;
      for (const entry of batch) {
        const tracked = this.tracked.get(entry.address);
        if (tracked === undefined) continue;
        const currentTask = tasks[entry.id];
        if (currentTask !== undefined) {
          this.dispatch(
            entry.address,
            { type: "persisted", task: currentTask, source: "write", now: this.clock.now() },
            { emit: false },
          );
        }
        if (sameOutcome(tracked.pendingWrite, entry.outcome)) tracked.pendingWrite = undefined;
      }
      this.flushRetries = 0;
      this.flushPaused = false;
    } catch (error) {
      this.reportError(error);
      if (error instanceof TaskStoreError && error.code === "tasks_full") {
        for (const entry of batch) {
          const tracked = this.tracked.get(entry.address);
          if (tracked && sameOutcome(tracked.pendingWrite, entry.outcome))
            tracked.pendingWrite = undefined;
        }
        this.flushRetries = 0;
        this.flushPaused = false;
      } else if (error instanceof TaskStoreError && error.code === "conflict") {
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
        this.flushPaused = true;
      }
    } finally {
      this.flushInFlight = false;
      if (succeeded && this.hasPendingWrites()) this.scheduleFlush();
    }
  }

  private hasPendingWrites(): boolean {
    return [...this.tracked.values()].some((tracked) => tracked.pendingWrite !== undefined);
  }

  private resumeFlushAfterChange(): void {
    if (!this.flushPaused) return;
    this.flushPaused = false;
    this.flushRetries = 0;
    this.scheduleFlush();
  }

  private beginSummaryRead(address: string, generation: number): void {
    const tracked = this.tracked.get(address);
    const job = tracked?.summaryJob;
    if (
      tracked === undefined ||
      job === undefined ||
      job.generation !== generation ||
      job.cancelled
    ) {
      return;
    }
    if (!this.summaryReadAllowed(tracked, job)) {
      this.dispatch(address, { type: "summary-result", generation }, { emit: false });
      return;
    }
    if (this.clock.now() >= job.deadline) {
      this.dispatch(address, { type: "summary-result", generation }, { emit: false });
      return;
    }

    this.dispatch(address, { type: "summary-started", generation }, { emit: false });
    const active = this.tracked.get(address)?.summaryJob;
    if (active === undefined || active.generation !== generation) return;
    const remaining = active.deadline - this.clock.now();
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      active.timeout = this.clock.setTimeout(() => resolve({ kind: "timeout" }), remaining);
    });
    const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
      active.cancelResolve = () => resolve({ kind: "cancelled" });
    });
    const request = this.connection.call("terminal.read", { terminal: address }).then(
      (value) => ({ kind: "result" as const, value }),
      () => ({ kind: "failed" as const }),
    );

    void Promise.race([request, timeout, cancelled]).then((result) => {
      const current = this.tracked.get(address)?.summaryJob;
      if (current !== active || active.cancelled || result.kind === "cancelled") return;
      if (active.timeout !== undefined) this.clock.clearTimeout(active.timeout);
      active.timeout = undefined;
      active.cancelResolve = undefined;

      if (result.kind === "result") {
        const rows = rowsFromRead(result.value);
        const terminal = this.tracked.get(address)?.terminal;
        const completion = this.tracked.get(address)?.completion;
        const status =
          completion?.turn === active.turn ? completion.status : currentStatus(tracked);
        const summary =
          rows === undefined || terminal === undefined
            ? undefined
            : summarize(getProgram(terminal).iconKey, status, rows);
        if (summary !== undefined) {
          this.dispatch(address, { type: "summary-result", generation, summary }, { emit: false });
          return;
        }
      }

      const latest = this.tracked.get(address)?.summaryJob;
      if (latest === undefined || latest.generation !== generation) return;
      if (latest.attempts < 2 && this.clock.now() < latest.deadline) {
        this.dispatch(address, { type: "summary-retry", generation }, { emit: false });
        this.scheduleSummaryTimer(address, latest, TASK_WATCHER_SUMMARY_RETRY_MS);
      } else {
        this.dispatch(address, { type: "summary-result", generation }, { emit: false });
      }
    });
  }

  private scheduleSummaryTimer(address: string, job: TrackedSummaryJob, delay: number): void {
    if (job.cancelled || job.state !== "scheduled" || job.timer !== undefined) return;
    const remaining = Math.max(0, job.deadline - this.clock.now());
    job.timer = this.clock.setTimeout(
      () => {
        job.timer = undefined;
        this.beginSummaryRead(address, job.generation);
      },
      Math.min(delay, remaining),
    );
  }

  private summaryReadAllowed(tracked: TrackedTask, job: TrackedSummaryJob): boolean {
    return (
      tracked.inTable &&
      tracked.terminal !== undefined &&
      terminalTurn(tracked.terminal) === job.turn &&
      canReadSummary(tracked)
    );
  }

  private cancelSummaryJob(job: TrackedSummaryJob): void {
    job.cancelled = true;
    job.cancelResolve?.();
    job.cancelResolve = undefined;
    if (job.timer !== undefined) this.clock.clearTimeout(job.timer);
    if (job.timeout !== undefined) this.clock.clearTimeout(job.timeout);
    job.timer = undefined;
    job.timeout = undefined;
  }

  private eventTerminalAddress(event: HcEvent): string | undefined {
    if (!isObject(event.data)) return undefined;
    const address = event.data.address;
    return typeof address === "string" ? address : undefined;
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

function needsSummaryRead(tracked: TrackedTask): boolean {
  const transition = transitionOf(tracked);
  if (transition?.kind !== "done" || !canReadSummary(tracked)) return false;
  const completion = tracked.completion;
  if (completion === undefined || completion.pending) return false;
  const job = tracked.summaryJob;
  if (job?.turn === transition.turn) return false;
  const status = completion.status ?? currentStatus(tracked);
  if (statusSummary(tracked, status) !== undefined) return false;
  const persisted = tracked.persistedOutcome;
  if (
    persisted?.state === "done" &&
    persisted.turn === transition.turn &&
    persisted.ended === trackedIsEnded(tracked) &&
    !tracked.eventSupersededOutcome
  ) {
    return false;
  }
  return true;
}
