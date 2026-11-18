/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  HcMethod,
  TaskOutcome,
  TaskRecord,
  TasksDocument,
  Terminal,
} from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { CoreConnectionStatus } from "./core-connection.ts";
import {
  desiredOutcome,
  type Mark,
  mark,
  reduce,
  sameOutcome,
  type Tracked,
} from "./task-knowledge.ts";
import { type TaskCoreCaller, TaskStore } from "./task-store.ts";
import { type TaskTransition, TaskWatcher, type TaskWatcherLogger } from "./task-watcher.ts";
import {
  buildDeliveries,
  type DeliveryItem,
  generateHistory,
  type History,
  type HistoryShape,
  oracle,
} from "./testing/deliveries.ts";
import { ModelCore, type ModelStep } from "./testing/model-core.ts";

const shapes: HistoryShape[] = ["events", "late-records", "epoch"];
const readLatencies = [1_600, 1_800, 500, 950, 250, 1_250];

class FakeClock implements Clock {
  nowValue: number;
  nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now = 0) {
    this.nowValue = now;
  }

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowValue + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  async advanceTo(target: number): Promise<void> {
    if (target < this.nowValue) throw new Error("history clock moved backwards");
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.nowValue = timer.at;
      timer.callback();
      await drain();
    }
    this.nowValue = target;
    await drain();
  }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

class FakeCore {
  document: TasksDocument = { v: 1, tasks: {} };
  version = 0;
  readonly calls: HcMethod[] = [];

  readonly call: TaskCoreCaller = async (method, params) => {
    this.calls.push(method as HcMethod);
    if (method === "doc.get") {
      return { value: structuredClone(this.document), version: this.version };
    }
    if (method === "terminal.list") return { terminals: [] };
    if (method !== "doc.set") throw new Error("unexpected history core method");
    const input = params as { version: number; value: TasksDocument };
    if (input.version !== this.version) throw new Error("unexpected history document conflict");
    this.document = structuredClone(input.value);
    this.version += 1;
    return { version: this.version };
  };
}

interface ReadObservation {
  address: string;
  at: number;
  lifePid: number | null;
  turn: number;
  text: string;
}

class FakeConnection {
  state: CoreConnectionStatus = { state: "live", since: 0, seq: 1, reconnects: 0 };
  readonly calls: Array<{ method: HcMethod; params: unknown }> = [];
  readonly reads: ReadObservation[] = [];
  readHandler: ((address: string) => Promise<unknown>) | undefined;
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  start(): void {}
  async stop(): Promise<void> {}
  resume(): void {}
  status(): CoreConnectionStatus {
    return this.state;
  }

  async call(method: HcMethod, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method !== "terminal.read") throw new Error("unexpected history watcher call");
    const handler = this.readHandler;
    return handler === undefined
      ? { complete: true, text: "No screen." }
      : handler((params as { terminal: string }).terminal);
  }

  observe(address: string, tracked: Tracked | undefined): Promise<unknown> {
    const turn = tracked?.view?.turn ?? 0;
    const lifePid = tracked?.lifePid ?? null;
    const text = `Screen ${address} life ${String(lifePid)} turn ${String(turn)}`;
    const index = this.reads.length;
    this.reads.push({ address, at: this.clock.now(), lifePid, turn, text });
    return new Promise((resolve) => {
      this.clock.setTimeout(
        () => resolve({ complete: true, how: "screen", text }),
        readLatencies[index % readLatencies.length] ?? 500,
      );
    });
  }
}

class FakeLogger implements TaskWatcherLogger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

interface ExpectedRead extends ReadObservation {
  token: number;
}

class KnowledgeEffects {
  readonly tracked = new Map<string, Tracked>();
  readonly emissions: Array<{ address: string; kind: Mark["kind"]; turn: number }> = [];
  readonly reads: ExpectedRead[] = [];
  private readonly completions: Array<{
    address: string;
    token: number;
    at: number;
    rows: readonly string[];
  }> = [];
  private nextToken = 0;
  private now = 0;
  private writeDueAt: number | undefined;
  private writing = false;

  constructor(addresses: readonly string[]) {
    for (const address of addresses) this.tracked.set(address, { address, present: false });
  }

  apply(item: DeliveryItem): void {
    if (item.type === "snapshot") {
      const found = new Set<string>();
      for (const view of item.terminals) {
        if (view.address.includes("/")) continue;
        found.add(view.address);
        this.input(view.address, { type: "seen", terminal: view, now: item.now }, "silent");
      }
      for (const [address, tracked] of this.tracked) {
        if (tracked.present && !found.has(address)) {
          this.input(address, { type: "missing", now: item.now }, "silent");
        }
      }
      return;
    }
    if (item.type === "event") {
      const address = item.event.terminal;
      if (address === undefined || address.includes("/")) return;
      if (item.event.type === "created" || item.event.type === "restarted") {
        const terminal = item.revealed ?? (item.event.data as unknown as Terminal);
        this.input(address, { type: "seen", terminal, now: item.now }, "event");
      } else {
        this.input(address, { type: "event", event: item.event, now: item.now }, "event");
      }
      return;
    }
    if (item.type === "record") {
      this.input(item.address, { type: "record", record: item.record, now: item.now }, "silent");
    }
  }

  advanceTo(target: number): void {
    for (;;) {
      const due = this.nextDue(target);
      const completion = this.nextCompletion(target);
      const writeAt =
        this.writeDueAt !== undefined && this.writeDueAt <= target ? this.writeDueAt : undefined;
      const nextAt = Math.min(
        due?.at ?? Number.POSITIVE_INFINITY,
        completion?.at ?? Number.POSITIVE_INFINITY,
        writeAt ?? Number.POSITIVE_INFINITY,
      );
      if (nextAt === Number.POSITIVE_INFINITY) break;
      if (writeAt !== undefined && writeAt === nextAt) {
        this.now = writeAt;
        this.writeDueAt = undefined;
        this.flushOutcomes();
      } else if (completion !== undefined && completion.at === nextAt) {
        this.now = completion.at;
        this.completions.splice(completion.index, 1);
        this.input(
          completion.address,
          {
            type: "summary-read",
            token: completion.token,
            now: this.now,
            rows: completion.rows,
          },
          "silent",
        );
      } else if (due !== undefined && due.at === nextAt) {
        this.now = due.at;
        const token = ++this.nextToken;
        const current = this.tracked.get(due.address) ?? { address: due.address, present: false };
        const previous = current.summary;
        const next = reduce(current, { type: "summary-due", now: this.now, token });
        const marked = mark(next, "silent");
        this.tracked.set(due.address, marked.tracked);
        this.scheduleWrite();
        if (
          previous?.phase === "waiting" &&
          marked.tracked.summary?.phase === "reading" &&
          marked.tracked.summary.token === token
        ) {
          const view = marked.tracked.view;
          const text = screenText(due.address, marked.tracked);
          const observation: ExpectedRead = {
            address: due.address,
            at: this.now,
            lifePid: marked.tracked.lifePid ?? null,
            turn: view?.turn ?? 0,
            text,
            token,
          };
          const index = this.reads.length;
          this.reads.push(observation);
          this.completions.push({
            address: due.address,
            token,
            at: this.now + (readLatencies[index % readLatencies.length] ?? 500),
            rows: [text],
          });
        }
      }
    }
    this.now = target;
  }

  expectedOutcome(address: string): TaskOutcome | undefined {
    const tracked = this.tracked.get(address);
    if (tracked?.record === undefined) return undefined;
    const desired = desiredOutcome(tracked, this.now);
    return desired.pending || desired.outcome === undefined
      ? tracked.record.outcome
      : desired.outcome;
  }

  private input(
    address: string,
    input: Parameters<typeof reduce>[1],
    source: "event" | "silent",
  ): void {
    const current = this.tracked.get(address) ?? { address, present: false };
    const result = mark(reduce(current, input), source);
    this.tracked.set(address, result.tracked);
    if (result.transition !== undefined && result.tracked.view !== undefined) {
      this.emissions.push({
        address,
        kind: result.transition.kind,
        turn: result.transition.turn,
      });
    }
    this.scheduleWrite();
  }

  private nextDue(target: number): { address: string; at: number } | undefined {
    let next: { address: string; at: number } | undefined;
    for (const [address, tracked] of this.tracked) {
      if (
        tracked.summary?.phase !== "waiting" ||
        tracked.summary.dueAt === undefined ||
        tracked.summary.dueAt > target
      ) {
        continue;
      }
      if (next === undefined || tracked.summary.dueAt < next.at) {
        next = { address, at: tracked.summary.dueAt };
      }
    }
    return next;
  }

  private nextCompletion(
    target: number,
  ):
    | { address: string; token: number; at: number; index: number; rows: readonly string[] }
    | undefined {
    let next:
      | { address: string; token: number; at: number; index: number; rows: readonly string[] }
      | undefined;
    for (const [index, completion] of this.completions.entries()) {
      if (completion.at > target) continue;
      if (next === undefined || completion.at < next.at) next = { ...completion, index };
    }
    return next;
  }

  private scheduleWrite(): void {
    if (this.writing || this.writeDueAt !== undefined || !this.hasPendingOutcomes()) return;
    this.writeDueAt = this.now + 300;
  }

  private hasPendingOutcomes(): boolean {
    for (const tracked of this.tracked.values()) {
      if (tracked.record === undefined || tracked.address.includes("/")) continue;
      const desired = desiredOutcome(tracked, this.now);
      if (
        !desired.pending &&
        desired.outcome !== undefined &&
        !sameOutcome(desired.outcome, tracked.record.outcome)
      ) {
        return true;
      }
    }
    return false;
  }

  private flushOutcomes(): void {
    const batch: Array<{ address: string; record: TaskRecord; outcome: TaskOutcome }> = [];
    for (const tracked of this.tracked.values()) {
      if (tracked.record === undefined || tracked.address.includes("/")) continue;
      const desired = desiredOutcome(tracked, this.now);
      if (
        desired.pending ||
        desired.outcome === undefined ||
        sameOutcome(desired.outcome, tracked.record.outcome)
      ) {
        continue;
      }
      batch.push({ address: tracked.address, record: tracked.record, outcome: desired.outcome });
    }
    this.writing = true;
    for (const item of batch) {
      this.input(
        item.address,
        {
          type: "record",
          record: { ...item.record, outcome: item.outcome },
          now: this.now,
        },
        "silent",
      );
    }
    this.writing = false;
    this.scheduleWrite();
  }
}

interface RunResult {
  outcomes: Map<string, TaskOutcome | undefined>;
  transitions: TaskTransition[];
  reads: ReadObservation[];
  core: FakeCore;
}

async function runDelivery(history: History, delivery: DeliveryItem[]): Promise<RunResult> {
  const clock = new FakeClock();
  const core = new FakeCore();
  const connection = new FakeConnection(clock);
  const logger = new FakeLogger();
  const effects = new KnowledgeEffects(history.addresses);
  connection.readHandler = async (address) =>
    connection.observe(address, effects.tracked.get(address));
  let watcher: TaskWatcher | undefined;
  const store = TaskStore.create(core.call, clock, {
    liveTerminals: () => watcher?.liveTerminals(),
  });
  const pendingRefreshes: Array<() => void> = [];
  const refresh = store.refresh.bind(store);
  store.refresh = () =>
    new Promise<void>((resolve, reject) => {
      pendingRefreshes.push(() => {
        void refresh().then(resolve, reject);
      });
    });

  watcher = new TaskWatcher({ connection, store, clock, logger });
  const transitions: TaskTransition[] = [];
  watcher.onTransition((transition) => transitions.push(transition));
  watcher.start();

  const advanceTo = async (now: number): Promise<void> => {
    await effects.advanceTo(now);
    await clock.advanceTo(now);
    await drain();
  };

  for (const item of delivery) {
    await advanceTo(item.now);
    if (item.type === "snapshot") {
      watcher.onSnapshot({ seq: 1, terminals: item.terminals });
      effects.apply(item);
    } else if (item.type === "event") {
      watcher.onEvent(item.event);
      effects.apply(item);
    } else if (item.type === "record") {
      if (item.record === undefined) {
        effects.apply(item);
        continue;
      }
      const record = item.record;
      const created = await store.create({
        ...(record.terminal === undefined ? {} : { terminal: item.address }),
        text: record.text ?? "Generated task",
        run: record.run ?? { kind: "program", id: "agent" },
        folder: record.folder ?? "/workspace",
        ...(record.space === undefined ? {} : { space: record.space }),
      });
      if (record.outcome !== undefined)
        await store.recordOutcomes({ [created.id]: record.outcome });
      effects.apply(item);
    } else if (item.type === "refresh") {
      pendingRefreshes.shift()?.();
      await drain();
    } else if (item.type === "change") {
      await store.recordOutcomes({});
      await drain();
    }
    await drain();
  }

  await drain();
  const outcomes = new Map<string, TaskOutcome | undefined>();
  for (const address of history.addresses) {
    const record = Object.values(store.snapshot().tasks).find((task) => task.terminal === address);
    outcomes.set(address, record?.outcome);
  }
  const result: RunResult = {
    outcomes,
    transitions,
    reads: connection.reads,
    core,
  };
  await watcher.stop();
  return result;
}

function screenText(address: string, tracked: Tracked): string {
  return (
    "Screen " +
    address +
    " life " +
    String(tracked.lifePid ?? null) +
    " turn " +
    String(tracked.view?.turn ?? 0)
  );
}

function normalizeOutcome(outcome?: TaskOutcome): unknown {
  if (outcome === undefined) return undefined;
  const { at: _at, ...rest } = outcome;
  return rest;
}

function normalizeOutcomes(
  outcomes: Map<string, TaskOutcome | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...outcomes].map(([address, outcome]) => [address, normalizeOutcome(outcome)]),
  );
}

function normalizeTransitions(transitions: TaskTransition[]): unknown {
  return transitions.map(({ address, kind, turn, record, question, summary }) => [
    address,
    kind,
    turn,
    record !== undefined,
    question,
    summary,
  ]);
}

function normalizeEmissions(
  transitions: Array<{ address: string; kind: Mark["kind"]; turn: number }>,
): unknown {
  return transitions.map(({ address, kind, turn }) => [address, kind, turn]);
}

function normalizeReads(reads: ReadObservation[]): unknown {
  return reads.map(({ address, at, lifePid, turn, text }) => [address, at, lifePid, turn, text]);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}\nactual: ${left}\nexpected: ${right}`);
}

describe("TaskWatcher generated histories", () => {
  test("refresh releases and clock advances are explicit delivery items", () => {
    const history = generateHistory(1, "events");
    const deliveries = buildDeliveries(history);
    for (const delivery of [deliveries.base, deliveries.equivalent, deliveries.epoch]) {
      expect(delivery.some((item) => item.type === "refresh")).toBe(true);
      expect(delivery.some((item) => item.type === "advance")).toBe(true);
      let previous = Number.NEGATIVE_INFINITY;
      for (const item of delivery) {
        expect(item.now).toBeGreaterThanOrEqual(previous);
        previous = item.now;
      }
    }
  });

  for (const shape of shapes) {
    test(`${shape}: 100 seeded watcher histories preserve outcomes, summaries, transitions, and read counts`, async () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const history = generateHistory(seed, shape);
        const deliveries = buildDeliveries(history);
        const base = await runDelivery(history, deliveries.base);
        const equivalent = await runDelivery(history, deliveries.equivalent);
        const epoch = await runDelivery(history, deliveries.epoch);

        assertEqual(
          normalizeOutcomes(base.outcomes),
          normalizeOutcomes(equivalent.outcomes),
          `${shape} seed ${seed}: equivalent written outcomes differ`,
        );
        assertEqual(
          normalizeTransitions(base.transitions),
          normalizeTransitions(equivalent.transitions),
          `${shape} seed ${seed}: equivalent transitions differ`,
        );
        for (const [label, run, delivery] of [
          ["base", base, deliveries.base],
          ["equivalent", equivalent, deliveries.equivalent],
          ["epoch", epoch, deliveries.epoch],
        ] as const) {
          assertReadHistory(history, delivery, run, `${shape} seed ${seed} ${label}`);
        }
      }
    });
  }

  test("the watcher rejects a stale summary read while a newer turn read is in flight", async () => {
    const history = scriptedTwoTurnHistory();
    const deliveries = buildDeliveries(history);
    const run = await runDelivery(history, deliveries.base);
    const outcome = run.outcomes.get("t1");

    expect(run.reads.map(({ turn }) => turn)).toEqual([1, 2]);
    const firstRead = run.reads[0];
    const secondRead = run.reads[1];
    expect(firstRead).toBeDefined();
    expect(secondRead?.at).toBeLessThan((firstRead?.at ?? 0) + (readLatencies[0] ?? 0));
    expect(outcome).toMatchObject({ state: "done", turn: 2 });
    expect(outcome?.summary).toBe("Screen t1 life 101 turn 2");
  });
});

function assertReadHistory(
  history: History,
  delivery: DeliveryItem[],
  run: RunResult,
  label: string,
): void {
  const effectFold = new KnowledgeEffects(history.addresses);
  for (const item of delivery) {
    effectFold.advanceTo(item.now);
    effectFold.apply(item);
  }
  assertEqual(
    normalizeReads(run.reads),
    normalizeReads(effectFold.reads),
    `${label}: summary reads do not follow the reducer jobs`,
  );
  assertEqual(
    normalizeEmissions(run.transitions),
    normalizeEmissions(effectFold.emissions),
    `${label}: transition emissions differ from revealed facts`,
  );
  for (const address of history.addresses) {
    const expectedOutcome = effectFold.expectedOutcome(address);
    assertEqual(
      normalizeOutcome(run.outcomes.get(address)),
      normalizeOutcome(expectedOutcome),
      `${label}: written outcome for ${address} differs from knowledge and read effects`,
    );
  }
  const oracleResult = oracle(delivery, history.addresses);
  for (const address of history.addresses) {
    const observed = oracleResult.outcomes.get(address);
    const actual = run.outcomes.get(address);
    if (observed === undefined || actual === undefined) continue;
    expect(actual.state, `${label}: oracle state for ${address}`).toBe(observed.state);
    expect(actual.turn, `${label}: oracle turn for ${address}`).toBe(observed.turn);
    expect(actual.ended, `${label}: oracle ended flag for ${address}`).toBe(observed.ended);
    expect(actual.exit, `${label}: oracle exit for ${address}`).toEqual(observed.exit);
  }
}

function scriptedTwoTurnHistory(): History {
  const steps: ModelStep[] = [
    {
      t: 0,
      address: "t1",
      kind: "create",
      argv: ["agent"],
      cwd: "/workspace",
      labels: {},
      pid: 101,
    },
    { t: 50, address: "t1", kind: "report", status: { state: "working" } },
    { t: 100, address: "t1", kind: "report", status: { state: "done" } },
    { t: 1_100, address: "t1", kind: "report", status: { state: "working" } },
    { t: 1_200, address: "t1", kind: "report", status: { state: "done" } },
  ];
  const model = new ModelCore();
  const create = steps[0];
  if (create === undefined) throw new Error("scripted history requires a create step");
  model.apply(create);
  const record: TaskRecord = {
    id: "tk00000000000000000000000000000001",
    origin: "phone",
    terminal: "t1",
    text: "Two turn history",
    run: { kind: "program", id: "agent" },
    folder: "/workspace",
    createdAt: 0,
  };
  return {
    seed: 20261117,
    shape: "events",
    addresses: ["t1"],
    steps,
    initial: model.snapshot(),
    linked: [{ address: "t1", record }],
    unlinked: [],
    cut: 3,
    emitNullStatus: false,
  };
}
