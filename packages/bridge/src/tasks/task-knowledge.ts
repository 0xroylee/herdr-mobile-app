import type {
  HcEvent,
  JsonValue,
  Status,
  TaskOutcome,
  TaskRecord,
  Terminal,
} from "@herdr-mobile/protocol";
import { applyEvent, getProgram, isEnded, oneLine, summarize } from "@herdr-mobile/protocol";

export interface StatusAt {
  turn: number;
  status: Status;
}

export interface Mark {
  kind: "needs-you" | "done" | "stopped";
  turn: number;
}

export interface SummaryJob {
  turn: number;
  deadline: number;
  attempts: 0 | 1 | 2;
  phase: "waiting" | "reading" | "settled";
  dueAt?: number;
  token?: number;
  result?: string;
}

export interface Tracked {
  address: string;
  /** Latest consistent view. Kept after removal. Undefined until first seen. */
  view?: Terminal;
  /** False once `removed` arrives or a snapshot lacks the address. */
  present: boolean;
  /** The current program life's non-null pid. */
  lifePid?: number;
  /** Last non-null status of this life and the turn it belongs to. */
  lastStatus?: StatusAt;
  /** Bridge clock when the terminal first ended or went missing. */
  endedAt?: number;
  /** The linked task record from the latest store snapshot. */
  record?: TaskRecord;
  /** Last class and turn emitted or absorbed. */
  marked?: Mark;
  summary?: SummaryJob;
}

/** Terminal facts deliberately carry no delivery-source tag. */
export type Input =
  | { type: "seen"; terminal: Terminal; now: number }
  | { type: "missing"; now: number }
  | { type: "event"; event: HcEvent; now: number }
  | { type: "record"; record: TaskRecord | undefined; now: number }
  | { type: "summary-due"; now: number; token: number }
  | { type: "summary-read"; token: number; now: number; rows?: readonly string[] };

export interface MarkResult {
  tracked: Tracked;
  transition?: Mark;
}

export type MarkSource = "event" | "silent";

interface SummaryResult {
  pending: boolean;
  summary?: string;
}

function terminalTurn(terminal: Terminal | undefined): number {
  return terminal?.turn ?? 0;
}

function ended(tracked: Tracked): boolean {
  return !tracked.present || tracked.view === undefined || isEnded(tracked.view);
}

function eligible(tracked: Tracked): boolean {
  return (
    tracked.record !== undefined ||
    tracked.view?.reported === true ||
    tracked.view?.status != null ||
    tracked.lastStatus !== undefined
  );
}

function isLocal(address: string): boolean {
  return !address.includes("/");
}

/** Derive the one current user-facing class from the terminal facts. */
export function classOf(tracked: Tracked): Mark | undefined {
  if (!eligible(tracked)) return undefined;

  const turn = terminalTurn(tracked.view);
  if (!ended(tracked)) {
    const status = tracked.view?.status;
    if (status?.state === "done" || (status?.state === "idle" && turn >= 1)) {
      return { kind: "done", turn };
    }
    if (status?.state === "blocked" || status?.state === "error") {
      return { kind: "needs-you", turn };
    }
    return undefined;
  }

  if (tracked.lastStatus?.status.state === "done") {
    return { kind: "done", turn: tracked.lastStatus.turn };
  }
  if (tracked.view?.exit_code === 0 && turn >= 1) return { kind: "done", turn };

  const outcome = tracked.record?.outcome;
  if (
    tracked.lastStatus === undefined &&
    outcome?.state === "done" &&
    (tracked.view === undefined || outcome.turn === turn)
  ) {
    return { kind: "done", turn: outcome.turn };
  }

  return { kind: "stopped", turn: tracked.view?.turn ?? outcome?.turn ?? 0 };
}

/** A terminal can be read after finishing, but never after it became a kept shell. */
export function readAllowed(tracked: Tracked): boolean {
  return (
    tracked.present &&
    tracked.view !== undefined &&
    !(tracked.view.state === "live" && tracked.view.reason != null)
  );
}

/** Compare persisted values without the bridge-local timestamp. */
export function sameOutcome(a?: TaskOutcome, b?: TaskOutcome): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.state === b.state &&
    a.turn === b.turn &&
    a.ended === b.ended &&
    a.summary === b.summary &&
    a.exit?.code === b.exit?.code &&
    a.exit?.signal === b.exit?.signal &&
    a.exit?.reason === b.exit?.reason
  );
}

/** Reduce one fact into a new record. The input record and its nested values are never mutated. */
export function reduce(tracked: Tracked, input: Input): Tracked {
  let next: Tracked;
  switch (input.type) {
    case "seen":
      next = see(tracked, input.terminal, input.now);
      break;
    case "missing":
      next = {
        ...tracked,
        present: false,
        endedAt: tracked.endedAt ?? input.now,
      };
      break;
    case "event":
      next = applyTerminalEvent(tracked, input.event, input.now);
      break;
    case "record":
      next = { ...tracked, record: input.record };
      break;
    case "summary-due":
      next = summaryDue(tracked, input.now, input.token);
      break;
    case "summary-read":
      next = summaryRead(tracked, input.now, input.token, input.rows);
      break;
  }

  return { ...reconcileSummary(next, input.now) };
}

function see(tracked: Tracked, terminal: Terminal, now: number): Tracked {
  const view = normalizeEndedTerminal(terminal);
  let lifePid = tracked.lifePid;
  let lastStatus = tracked.lastStatus;
  let summary = tracked.summary;
  if (view.pid != null && view.pid !== lifePid) {
    lifePid = view.pid;
    lastStatus = undefined;
    summary = undefined;
  }
  if (view.status != null) lastStatus = { turn: terminalTurn(view), status: view.status };

  return {
    ...tracked,
    view,
    present: true,
    lifePid,
    lastStatus,
    summary,
    endedAt: isEnded(view) ? (tracked.endedAt ?? now) : tracked.endedAt,
  };
}

function normalizeEndedTerminal(terminal: Terminal): Terminal {
  if (!isEnded(terminal) || terminal.status === null) return terminal;
  return { ...terminal, status: null };
}

function applyTerminalEvent(tracked: Tracked, event: HcEvent, now: number): Tracked {
  if (event.type === "removed") {
    if (event.terminal !== tracked.address || asObject(event.data) === undefined) {
      return { ...tracked };
    }
    return {
      ...tracked,
      present: false,
      endedAt: tracked.endedAt ?? now,
    };
  }

  if (event.type === "created" || event.type === "restarted") {
    const terminal = applyEvent({}, event, now)[terminalAddress(event) ?? ""];
    return terminal === undefined ? { ...tracked } : see(tracked, terminal, now);
  }

  if (tracked.view === undefined || event.terminal !== tracked.address) {
    if (
      event.type === "labels" &&
      tracked.view === undefined &&
      event.terminal === tracked.address
    ) {
      const terminal = applyEvent({}, event, now)[tracked.address];
      if (terminal !== undefined) return see(tracked, terminal, now);
    }
    return { ...tracked };
  }

  const status = eventStatus(event);
  const previous = tracked.view.status;
  const predictedTurn =
    event.type === "status" &&
    status != null &&
    previous?.state === "working" &&
    status.state !== "working"
      ? terminalTurn(tracked.view) + 1
      : terminalTurn(tracked.view);
  const table = applyEvent({ [tracked.address]: tracked.view }, event, now);
  let view = table[tracked.address];
  if (view === undefined || view === tracked.view) return { ...tracked };

  let lastStatus = tracked.lastStatus;
  if (event.type === "status" && status !== undefined && status !== null) {
    view = { ...view, turn: predictedTurn };
    lastStatus = { turn: predictedTurn, status };
  }
  if (event.type === "finished" || event.type === "lost") {
    view = normalizeEndedTerminal(view);
  }

  const next: Tracked = {
    ...tracked,
    view,
    lastStatus,
    endedAt:
      event.type === "finished" || event.type === "lost"
        ? (tracked.endedAt ?? now)
        : tracked.endedAt,
  };
  return next;
}

function terminalAddress(event: HcEvent): string | undefined {
  const data = asObject(event.data);
  return data !== undefined && typeof data.address === "string" ? data.address : event.terminal;
}

function eventStatus(event: HcEvent): Status | null | undefined {
  if (event.type !== "status") return undefined;
  const data = asObject(event.data);
  if (data === undefined || !("status" in data)) return undefined;
  if (data.status === null) return null;
  const status = asObject(data.status);
  return status !== undefined && typeof status.state === "string"
    ? (status as unknown as Status)
    : undefined;
}

function asObject(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function summaryDue(tracked: Tracked, now: number, token: number): Tracked {
  const job = tracked.summary;
  if (job?.phase !== "waiting") return { ...tracked };
  if (!readAllowed(tracked) || now >= job.deadline) {
    return { ...tracked, summary: settled(job) };
  }
  return {
    ...tracked,
    summary: {
      turn: job.turn,
      deadline: job.deadline,
      attempts: job.attempts,
      phase: "reading",
      token,
    },
  };
}

function summaryRead(
  tracked: Tracked,
  now: number,
  token: number,
  rows: readonly string[] | undefined,
): Tracked {
  const job = tracked.summary;
  if (job?.phase !== "reading" || job.token !== token) return { ...tracked };

  const result =
    rows === undefined || tracked.view === undefined
      ? undefined
      : summarize(
          summaryProgramKey(tracked, job.turn),
          tracked.lastStatus?.turn === job.turn ? tracked.lastStatus.status : undefined,
          rows,
        );
  if (result !== undefined) return { ...tracked, summary: settled(job, result) };
  if (job.attempts < 2 && now + 2_000 < job.deadline) {
    return {
      ...tracked,
      summary: {
        turn: job.turn,
        deadline: job.deadline,
        attempts: (job.attempts + 1) as SummaryJob["attempts"],
        phase: "waiting",
        dueAt: now + 2_000,
      },
    };
  }
  return { ...tracked, summary: settled(job) };
}

function settled(job: SummaryJob, result?: string): SummaryJob {
  return {
    turn: job.turn,
    deadline: job.deadline,
    attempts: job.attempts,
    phase: "settled",
    ...(result === undefined ? {} : { result }),
  };
}

function hasDirectSummary(tracked: Tracked, turn: number): boolean {
  return tracked.lastStatus?.turn === turn && oneLine(tracked.lastStatus.status.msg) !== undefined;
}

function hasPersistedDone(tracked: Tracked, turn: number): boolean {
  return tracked.record?.outcome?.state === "done" && tracked.record.outcome.turn === turn;
}

function summaryProgramKey(tracked: Tracked, turn: number): string {
  if (tracked.view === undefined) return "bot";
  const status =
    tracked.lastStatus?.turn === turn ? tracked.lastStatus.status : tracked.view.status;
  return getProgram({ ...tracked.view, status }).iconKey;
}

function reconcileSummary(tracked: Tracked, now: number): Tracked {
  const current = classOf(tracked);
  let summary = tracked.summary;
  if (
    summary !== undefined &&
    (current?.kind !== "done" || current.turn !== summary.turn || tracked.record === undefined)
  ) {
    summary = undefined;
  }

  if (summary !== undefined && hasDirectSummary(tracked, summary.turn)) summary = undefined;
  if (summary !== undefined && hasPersistedDone(tracked, summary.turn)) summary = undefined;
  if (summary !== undefined && !readAllowed(tracked) && summary.phase !== "settled") {
    summary = settled(summary);
  }

  if (summary === undefined && current?.kind === "done" && tracked.record !== undefined) {
    if (
      !hasDirectSummary(tracked, current.turn) &&
      !hasPersistedDone(tracked, current.turn) &&
      readAllowed(tracked)
    ) {
      summary = {
        turn: current.turn,
        deadline: now + 3_000,
        attempts: 0,
        phase: "waiting",
        dueAt: now + 750,
      };
    }
  }

  return summary === tracked.summary ? tracked : { ...tracked, summary };
}

function summaryFor(tracked: Tracked, turn: number): SummaryResult {
  if (tracked.lastStatus?.turn === turn && oneLine(tracked.lastStatus.status.msg) !== undefined) {
    return {
      pending: false,
      summary: summarize(summaryProgramKey(tracked, turn), tracked.lastStatus.status, []),
    };
  }

  const job = tracked.summary?.turn === turn ? tracked.summary : undefined;
  if (job !== undefined) {
    return job.phase === "settled" ? { pending: false, summary: job.result } : { pending: true };
  }

  const persisted = tracked.record?.outcome;
  if (persisted?.state === "done" && persisted.turn === turn) {
    return { pending: false, summary: persisted.summary };
  }

  if (!readAllowed(tracked) || tracked.record === undefined) return { pending: false };
  return { pending: true };
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

function outcomeExit(terminal: Terminal | undefined): TaskOutcome["exit"] | undefined {
  if (terminal === undefined || !hasExitDetails(terminal)) return undefined;
  return {
    code: terminal.exit_code ?? null,
    signal: terminal.signal ?? null,
    reason: terminal.reason ?? null,
  };
}

/** Derive the document value and whether a screen summary still needs to settle. */
export function desiredOutcome(
  tracked: Tracked,
  now: number,
): { outcome?: TaskOutcome; pending: boolean } {
  if (tracked.record === undefined || !isLocal(tracked.address)) return { pending: false };
  if (
    tracked.view === undefined &&
    !tracked.present &&
    tracked.lastStatus === undefined &&
    tracked.record.outcome !== undefined
  ) {
    return { outcome: tracked.record.outcome, pending: false };
  }

  const current = classOf(tracked);
  if (current === undefined || current.kind === "needs-you") return { pending: false };

  if (current.kind === "stopped") {
    return {
      outcome: {
        state: "stopped",
        turn: current.turn,
        ended: true,
        at: now,
        ...(outcomeExit(tracked.view) === undefined ? {} : { exit: outcomeExit(tracked.view) }),
      },
      pending: false,
    };
  }

  const summary = summaryFor(tracked, current.turn);
  if (summary.pending) return { pending: true };
  return {
    outcome: {
      state: "done",
      turn: current.turn,
      ended: ended(tracked),
      at: now,
      ...(summary.summary === undefined ? {} : { summary: summary.summary }),
    },
    pending: false,
  };
}

/** Apply event-only hook emission and silently absorb snapshot/document observations. */
export function mark(tracked: Tracked, source: MarkSource): MarkResult {
  const current = classOf(tracked);
  if (current === undefined) return { tracked: { ...tracked } };

  const changed = tracked.marked?.kind !== current.kind || tracked.marked?.turn !== current.turn;
  return {
    tracked: { ...tracked, marked: current },
    ...(source === "event" && changed ? { transition: current } : {}),
  };
}
