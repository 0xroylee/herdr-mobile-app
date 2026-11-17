import type { HcEvent, Status, TaskOutcome, TaskRecord, Terminal } from "@herdr-mobile/protocol";
import { getProgram, oneLine, summarize } from "@herdr-mobile/protocol";
import { ModelCore, type ModelEvent, type ModelStep } from "./model-core.ts";

export type HistoryShape = "events" | "late-records" | "epoch";

export type DeliveryItem =
  | { type: "snapshot"; now: number; terminals: Terminal[] }
  | { type: "event"; now: number; event: HcEvent; revealed?: Terminal }
  | { type: "record"; now: number; address: string; record: TaskRecord | undefined }
  | { type: "refresh"; now: number }
  | { type: "change"; now: number };

export interface HistoryGroup {
  now: number;
  events: ModelEvent[];
  terminals: Terminal[];
}

export interface History {
  seed: number;
  shape: HistoryShape;
  addresses: string[];
  steps: ModelStep[];
  initial: Terminal[];
  linked: Array<{ address: string; record: TaskRecord }>;
  unlinked: TaskRecord[];
  cut: number;
  emitNullStatus: boolean;
}

export interface Deliveries {
  base: DeliveryItem[];
  equivalent: DeliveryItem[];
  epoch: DeliveryItem[];
}

export interface OracleResult {
  outcomes: Map<string, TaskOutcome | undefined>;
  pending: string[];
  summaryKnown: Set<string>;
  emissions: Array<{ address: string; kind: "needs-you" | "done" | "stopped"; turn: number }>;
}

interface OracleState {
  address: string;
  present: boolean;
  view?: Terminal;
  lifePid?: number;
  lastStatus?: { turn: number; status: Status };
  record?: TaskRecord;
  marked?: { kind: "needs-you" | "done" | "stopped"; turn: number };
}

/** Small, reproducible PRNG used only by the history generator. */
export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function generateHistory(seed: number, shape: HistoryShape): History {
  const shapeSeed =
    seed ^ (shape === "events" ? 0x13579bdf : shape === "late-records" ? 0x2468ace0 : 0x5a17e123);
  const random = mulberry32(shapeSeed);
  const count = 1 + int(random, 3);
  const addresses = Array.from({ length: count }, (_, index) => `t${index + 1}`);
  const steps: ModelStep[] = addresses.map((address, index) => ({
    t: 0,
    address,
    kind: "create",
    argv: [["claude"], ["codex"], ["agent"]][int(random, 3)] ?? ["agent"],
    cwd: `/workspace/project-${index + 1}`,
    labels: { "herdr.space": `space-${index + 1}` },
    pid: 100 + index,
  }));

  const statuses: Status[] = [
    { state: "working", title: "Working" },
    { state: "done", msg: "Generated completion" },
    { state: "done" },
    { state: "idle" },
    { state: "blocked", msg: "Generated question", title: "Approval" },
    { state: "error", msg: "Generated error" },
  ];
  for (const [index, address] of addresses.entries()) {
    const actions = 1 + int(random, 7);
    let time = 100 + int(random, 500);
    let mode: "live" | "ended" | "shell" | "removed" = "live";
    for (let action = 0; action < actions; action += 1) {
      time += 1 + int(random, 800);
      if (action === 0 || (mode === "live" && random() < 0.68)) {
        const status: Status = statuses[int(random, statuses.length)] ?? { state: "working" };
        steps.push({ t: time, address, kind: "report", status: { ...status } });
      } else if (mode === "live" && random() < 0.38) {
        const keep = random() < 0.3;
        steps.push({
          t: time,
          address,
          kind: "exit",
          code: random() < 0.7 ? ([0, 1, 7][int(random, 3)] ?? 1) : null,
          signal: random() < 0.15 ? 9 : null,
          keep,
        });
        mode = keep ? "shell" : "ended";
      } else if ((mode === "ended" || mode === "shell") && random() < 0.45) {
        steps.push({ t: time, address, kind: "restart", pid: 200 + index + action });
        mode = "live";
      } else if (action === actions - 1 && mode !== "removed" && random() < 0.45) {
        steps.push({ t: time, address, kind: "remove" });
        mode = "removed";
      } else {
        steps.push({
          t: time,
          address,
          kind: "meta",
          labels: { "herdr.space": `space-${index + 1}`, note: `m${action}` },
        });
      }
    }
  }
  steps.splice(
    addresses.length,
    steps.length - addresses.length,
    ...steps.slice(addresses.length).sort((a, b) => a.t - b.t),
  );

  const model = new ModelCore();
  for (const step of steps.filter((item) => item.kind === "create")) model.apply(step);
  const initial = model.snapshot();

  const linked: History["linked"] = [];
  const unlinked: TaskRecord[] = [];
  for (const [index, address] of addresses.entries()) {
    const mode = int(random, 4);
    if (mode === 0) continue;
    const id = taskId(seed, index);
    const outcome: TaskOutcome | undefined =
      mode === 2
        ? {
            state: random() < 0.7 ? ("done" as const) : ("stopped" as const),
            turn: int(random, 5),
            ended: random() < 0.5,
            at: int(random, 10_000),
            ...(random() < 0.5 ? { summary: "Persisted summary" } : {}),
          }
        : undefined;
    const record: TaskRecord = {
      id,
      origin: "phone",
      createdAt: int(random, 10_000),
      ...(mode === 3 ? {} : { terminal: address }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(mode === 3
        ? {
            run: { kind: "program" as const, id: "claude" },
            folder: `/workspace/project-${index + 1}`,
          }
        : {}),
    };
    if (mode === 3) unlinked.push(record);
    else linked.push({ address, record });
  }

  return {
    seed,
    shape,
    addresses,
    steps,
    initial,
    linked,
    unlinked,
    cut: steps.length > 1 ? 1 + int(random, steps.length - 1) : 0,
    emitNullStatus: random() < 0.5,
  };
}

export function buildDeliveries(history: History): Deliveries {
  const baseGroups = simulate(history.steps, history.emitNullStatus);
  const equivalentGroups = simulate(history.steps, !history.emitNullStatus);
  const linked = history.linked;
  const base: DeliveryItem[] = [
    snapshot(0, history.initial),
    { type: "refresh", now: 0 },
    ...records(history, 0),
    ...events(baseGroups),
  ];

  const equivalent: DeliveryItem[] = [snapshot(0, history.initial)];
  const lastEvent = new Map<string, number>();
  equivalentGroups.forEach((group, index) => {
    const address = group.events[0]?.event.terminal;
    if (address !== undefined) lastEvent.set(address, index);
  });
  const arrivals = new Map<number, Array<{ address: string; record: TaskRecord }>>();
  for (const item of linked) {
    const last = lastEvent.get(item.address) ?? 0;
    const boundary =
      history.shape === "late-records"
        ? int(mulberry32(history.seed + item.record.createdAt), last + 1)
        : 0;
    const existing = arrivals.get(boundary) ?? [];
    existing.push(item);
    arrivals.set(boundary, existing);
  }
  const restates = new Map<number, number>();
  const refreshes = new Set<number>();
  if (equivalentGroups.length > 0) {
    const random = mulberry32(history.seed ^ 0x713b9a41);
    for (let index = 0; index < Math.min(3, equivalentGroups.length); index += 1) {
      const boundary = 1 + int(random, equivalentGroups.length);
      restates.set(boundary, (restates.get(boundary) ?? 0) + 1);
    }
    refreshes.add(int(random, equivalentGroups.length + 1));
  }
  let lastSnapshot = history.initial;
  for (let boundary = 0; boundary <= equivalentGroups.length; boundary += 1) {
    const now = boundaryTime(equivalentGroups, boundary);
    for (const item of arrivals.get(boundary) ?? []) {
      equivalent.push({
        type: "record",
        now,
        address: item.address,
        record: item.record,
      });
    }
    if (refreshes.has(boundary)) equivalent.push({ type: "refresh", now });
    if (boundary > 0) lastSnapshot = equivalentGroups[boundary - 1]?.terminals ?? lastSnapshot;
    for (let count = restates.get(boundary) ?? 0; count > 0; count -= 1) {
      equivalent.push(snapshot(now, lastSnapshot));
    }
    if (boundary > 0 && boundary % 3 === 0) equivalent.push({ type: "change", now });
    const group = equivalentGroups[boundary];
    if (group !== undefined) {
      for (const event of group.events) {
        equivalent.push({
          type: "event",
          now: group.now,
          event: event.event,
          ...(event.revealed === undefined ? {} : { revealed: event.revealed }),
        });
      }
    }
  }
  const cut = Math.min(history.cut, baseGroups.length);
  const epochState =
    cut === 0 ? history.initial : (baseGroups[cut - 1]?.terminals ?? history.initial);
  const epoch: DeliveryItem[] = [
    snapshot(0, history.initial),
    ...records(history, 0),
    snapshot(baseGroups[cut - 1]?.now ?? 0, epochState),
    ...events(baseGroups.slice(cut)),
  ];
  return { base, equivalent, epoch };
}

/** Expected outcomes and hooks folded from the states a delivery actually reveals. */
export function oracle(delivery: DeliveryItem[], addresses: string[]): OracleResult {
  const states = new Map(
    addresses.map((address) => [address, { address, present: false } as OracleState]),
  );
  const emissions: OracleResult["emissions"] = [];
  for (const item of delivery) {
    if (item.type === "snapshot") {
      const found = new Set<string>();
      for (const terminal of item.terminals) {
        if (terminal.address.includes("/")) continue;
        found.add(terminal.address);
        see(states, terminal.address, terminal);
        reveal(states, terminal.address, "silent", emissions);
      }
      for (const [address, state] of states) {
        if (state.present && !found.has(address)) {
          state.present = false;
          reveal(states, address, "silent", emissions);
        }
      }
    } else if (item.type === "event") {
      const address = item.event.terminal;
      if (address === undefined || address.includes("/")) continue;
      const state = getState(states, address);
      const event = item.event;
      if (event.type === "created" || event.type === "restarted") {
        see(states, address, item.revealed ?? (event.data as unknown as Terminal));
      } else if (event.type === "removed") {
        state.present = false;
      } else if (state.view !== undefined) {
        const data = event.data as unknown as Record<string, unknown>;
        if (event.type === "status") {
          const status = data.status as Status | null | undefined;
          const turn =
            status != null && state.view.status?.state === "working" && status.state !== "working"
              ? (state.view.turn ?? 0) + 1
              : (state.view.turn ?? 0);
          state.view = normalizeOracleTerminal({
            ...state.view,
            ...(item.revealed ?? {}),
            status: status ?? null,
            turn,
          });
          if (status != null) state.lastStatus = { turn, status };
        } else if (event.type === "turn") {
          state.view = normalizeOracleTerminal({
            ...state.view,
            ...(item.revealed ?? {}),
            turn: data.turn as number,
          });
        } else {
          state.view = normalizeOracleTerminal({ ...state.view, ...(item.revealed ?? {}) });
        }
      }
      reveal(states, address, "event", emissions);
    } else if (item.type === "record") {
      const state = getState(states, item.address);
      state.record = item.record;
      reveal(states, item.address, "silent", emissions);
    }
  }

  const outcomes = new Map<string, TaskOutcome | undefined>();
  const pending: string[] = [];
  const summaryKnown = new Set<string>();
  for (const address of addresses) {
    const state = states.get(address);
    if (state === undefined) continue;
    const result = oracleOutcome(state);
    outcomes.set(address, result.outcome);
    if (result.pending) pending.push(address);
    if (
      result.outcome?.state === "done" &&
      (hasDirectSummary(state, result.outcome.turn) || hasPersistedDone(state, result.outcome.turn))
    ) {
      summaryKnown.add(address);
    }
  }
  return { outcomes, pending, summaryKnown, emissions };
}

function see(states: Map<string, OracleState>, address: string, terminal: Terminal): void {
  const state = getState(states, address);
  const view = normalizeOracleTerminal(terminal);
  if (view.pid != null && view.pid !== state.lifePid) {
    state.lifePid = view.pid;
    state.lastStatus = undefined;
  }
  if (view.status != null) state.lastStatus = { turn: view.turn ?? 0, status: view.status };
  state.view = view;
  state.present = true;
}

function normalizeOracleTerminal(terminal: Terminal): Terminal {
  return terminal.state === "finished" || terminal.reason != null
    ? { ...terminal, status: null }
    : terminal;
}

function reveal(
  states: Map<string, OracleState>,
  address: string,
  source: "event" | "silent",
  emissions: OracleResult["emissions"],
): void {
  const state = getState(states, address);
  const current = oracleClass(state);
  if (current === undefined) return;
  const changed = state.marked?.kind !== current.kind || state.marked?.turn !== current.turn;
  state.marked = current;
  if (source === "event" && changed && state.view !== undefined) {
    emissions.push({ address, kind: current.kind, turn: current.turn });
  }
}

function oracleClass(state: OracleState): OracleState["marked"] {
  if (
    state.record === undefined &&
    state.view?.reported !== true &&
    state.view?.status == null &&
    state.lastStatus === undefined
  ) {
    return undefined;
  }
  const turn = state.view?.turn ?? 0;
  const ended = oracleEnded(state);
  if (!ended) {
    const status = state.view?.status;
    if (status?.state === "done" || (status?.state === "idle" && turn >= 1)) {
      return { kind: "done", turn };
    }
    if (status?.state === "blocked" || status?.state === "error") {
      return { kind: "needs-you", turn };
    }
    return undefined;
  }
  if (state.lastStatus?.status.state === "done") {
    return { kind: "done", turn: state.lastStatus.turn };
  }
  if (state.view?.exit_code === 0 && turn >= 1) return { kind: "done", turn };
  const outcome = state.record?.outcome;
  if (
    state.lastStatus === undefined &&
    outcome?.state === "done" &&
    (state.view === undefined || outcome.turn === turn)
  ) {
    return { kind: "done", turn: outcome.turn };
  }
  return { kind: "stopped", turn: state.view?.turn ?? outcome?.turn ?? 0 };
}

function oracleEnded(state: OracleState): boolean {
  return (
    !state.present ||
    state.view === undefined ||
    state.view.state === "finished" ||
    state.view.reason != null
  );
}

function oracleReadAllowed(state: OracleState): boolean {
  return (
    state.present &&
    state.view !== undefined &&
    !(state.view.state === "live" && state.view.reason != null)
  );
}

function hasDirectSummary(state: OracleState, turn: number): boolean {
  return state.lastStatus?.turn === turn && oneLine(state.lastStatus.status.msg) !== undefined;
}

function hasPersistedDone(state: OracleState, turn: number): boolean {
  return state.record?.outcome?.state === "done" && state.record.outcome.turn === turn;
}

function oracleOutcome(state: OracleState): { outcome?: TaskOutcome; pending: boolean } {
  const record = state.record;
  if (record === undefined || state.address.includes("/")) return { pending: false };
  if (
    state.view === undefined &&
    !state.present &&
    state.lastStatus === undefined &&
    record.outcome !== undefined
  ) {
    return { outcome: record.outcome, pending: false };
  }

  const current = oracleClass(state);
  if (current === undefined || current.kind === "needs-you") return { pending: false };
  if (current.kind === "stopped") {
    const view = state.view;
    const exit =
      view !== undefined &&
      (view.state === "finished" ||
        view.reason != null ||
        view.exit_code != null ||
        view.signal != null)
        ? { code: view.exit_code ?? null, signal: view.signal ?? null, reason: view.reason ?? null }
        : undefined;
    return {
      outcome: {
        state: "stopped",
        turn: current.turn,
        ended: true,
        at: 0,
        ...(exit === undefined ? {} : { exit }),
      },
      pending: false,
    };
  }

  const status = state.lastStatus?.turn === current.turn ? state.lastStatus.status : undefined;
  const directSummary = hasDirectSummary(state, current.turn);
  const persistedDone = hasPersistedDone(state, current.turn);
  const summary =
    directSummary && status !== undefined && state.view !== undefined
      ? summarize(getProgram({ ...state.view, status }).iconKey, status, [])
      : persistedDone
        ? record.outcome?.summary
        : undefined;
  return {
    outcome: {
      state: "done",
      turn: current.turn,
      ended: oracleEnded(state),
      at: 0,
      ...(summary === undefined ? {} : { summary }),
    },
    pending: !directSummary && !persistedDone && oracleReadAllowed(state),
  };
}

function getState(states: Map<string, OracleState>, address: string): OracleState {
  const existing = states.get(address);
  if (existing !== undefined) return existing;
  const created: OracleState = { address, present: false };
  states.set(address, created);
  return created;
}

function simulate(steps: ModelStep[], emitNullStatus: boolean): HistoryGroup[] {
  const model = new ModelCore();
  const result: HistoryGroup[] = [];
  const creates = steps.filter((step) => step.kind === "create");
  const createdEvents = creates.map((step) => model.apply(step, emitNullStatus));
  const initial = model.snapshot();
  for (const [index, step] of creates.entries()) {
    result.push({ now: step.t, events: createdEvents[index] ?? [], terminals: initial });
  }
  for (const step of steps.filter((item) => item.kind !== "create")) {
    const events = model.apply(step, emitNullStatus);
    result.push({ now: step.t, events, terminals: model.snapshot() });
  }
  return result;
}

function records(history: History, now: number): DeliveryItem[] {
  return history.linked.map(({ address, record }) => ({ type: "record", now, address, record }));
}

function events(groups: HistoryGroup[]): DeliveryItem[] {
  return groups.flatMap((group) =>
    group.events.map((event) => ({
      type: "event" as const,
      now: group.now,
      event: event.event,
      ...(event.revealed === undefined ? {} : { revealed: event.revealed }),
    })),
  );
}

function snapshot(now: number, terminals: Terminal[]): DeliveryItem {
  return { type: "snapshot", now, terminals: terminals.map((terminal) => ({ ...terminal })) };
}

function boundaryTime(groups: HistoryGroup[], boundary: number): number {
  const before = groups[boundary - 1]?.now ?? 0;
  const after = groups[boundary]?.now ?? before;
  if (boundary <= 0) return Math.max(0, after);
  if (boundary >= groups.length) return before;
  return before + (after - before) / 2;
}

function int(random: () => number, upperExclusive: number): number {
  return Math.floor(random() * upperExclusive);
}

function taskId(seed: number, index: number): string {
  const suffix = `${(seed >>> 0).toString(16).padStart(8, "0")}${index.toString(16).padStart(2, "0")}`;
  return `tk${suffix.padStart(32, "0")}`;
}
