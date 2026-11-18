/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type {
  HcEvent,
  HcMethod,
  Status,
  TaskRecord,
  TasksDocument,
  Terminal,
} from "@herdr-mobile/protocol";
import { claudeDoneScreen, codexDoneScreen } from "../../../protocol/src/summary/fixtures.ts";
import type { Clock } from "../prototype/deadline.ts";
import type { CoreConnectionStatus } from "./core-connection.ts";
import { type TaskCoreCaller, TaskStore, TaskStoreError } from "./task-store.ts";
import { type TaskTransition, TaskWatcher, type TaskWatcherLogger } from "./task-watcher.ts";

class FakeClock implements Clock {
  nowValue: number;
  nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now = 100_000) {
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

  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.nowValue + ms);
  }

  async advanceTo(target: number): Promise<void> {
    if (target < this.nowValue) throw new Error("fake clock cannot move backwards");
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
  version = 3;
  lists = 0;
  conflicts = 0;
  writeError: Error | undefined;
  listTerminals: Terminal[] = [];
  readonly calls: HcMethod[] = [];
  readonly sets: Array<{ version: number; value: TasksDocument }> = [];

  readonly call: TaskCoreCaller = async (method, params) => {
    this.calls.push(method as HcMethod);
    if (method === "doc.get") {
      expect(params).toEqual({ name: "herdr-mobile.tasks" });
      return { value: structuredClone(this.document), version: this.version };
    }
    if (method === "terminal.list") {
      this.lists += 1;
      return { terminals: structuredClone(this.listTerminals) };
    }
    if (method !== "doc.set") throw new Error("unexpected core method");
    const input = params as { version: number; value: TasksDocument };
    this.sets.push({ version: input.version, value: structuredClone(input.value) });
    if (this.writeError !== undefined) throw this.writeError;
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      this.version += 1;
      throw new HcRpcError({
        code: -32000,
        message: "document version conflict",
        data: { kind: "conflict" },
      });
    }
    if (input.version !== this.version) {
      throw new HcRpcError({
        code: -32000,
        message: "document version conflict",
        data: { kind: "conflict" },
      });
    }
    this.document = structuredClone(input.value);
    this.version += 1;
    return { version: this.version };
  };
}

class FakeConnection {
  state: CoreConnectionStatus = { state: "live", since: 90_000, seq: 1, reconnects: 0 };
  starts = 0;
  stops = 0;
  resumes = 0;
  readonly calls: Array<{ method: HcMethod; params: unknown }> = [];
  readHandler: ((address: string) => Promise<unknown>) | undefined;

  start(): void {
    this.starts += 1;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.state = { ...this.state, state: "stopped" };
  }

  resume(): void {
    this.resumes += 1;
  }

  status(): CoreConnectionStatus {
    return this.state;
  }

  async call(method: HcMethod, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method !== "terminal.read") throw new Error("unexpected watcher call");
    const address = (params as { terminal: string }).terminal;
    return (
      this.readHandler?.(address) ?? {
        complete: true,
        how: "screen",
        text: "Finished successfully.",
      }
    );
  }
}

class FakeLogger implements TaskWatcherLogger {
  readonly entries: Array<{
    level: "info" | "error";
    message: string;
    fields?: Record<string, unknown>;
  }> = [];

  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: "info", message, fields });
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: "error", message, fields });
  }
}

const id = (digit: string): string =>
  `tk${(Number.parseInt(digit, 36) % 16).toString(16).repeat(32)}`;

function taskRecord(key: string, changes: Partial<TaskRecord> = {}): TaskRecord {
  const record: TaskRecord = {
    id: key,
    origin: "phone",
    terminal: "t1",
    text: "PRIVATE TASK TEXT",
    run: { kind: "program", id: "claude" },
    folder: "/repo",
    createdAt: 100_000,
    ...changes,
  };
  if (record.terminal === undefined) delete record.terminal;
  return record;
}

function terminal(address = "t1", changes: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 100,
    created_ms: 99_900,
    cwd: "/repo",
    foreground: { pid: 23, name: "claude", argv: ["claude"], cwd: "/repo" },
    labels: {},
    pid: 23,
    records: {},
    reported: true,
    rows: 32,
    screen: "last screen",
    state: "live",
    status: { state: "working" },
    status_ms: 99_900,
    turn: 0,
    ...changes,
  };
}

interface Harness {
  clock: FakeClock;
  core: FakeCore;
  connection: FakeConnection;
  logger: FakeLogger;
  store: TaskStore;
  transitions: TaskTransition[];
  watcher: TaskWatcher;
  releaseRefresh(): Promise<void>;
}

async function harness(
  records: TaskRecord[] = [],
  options: { deferRefresh?: boolean; now?: number } = {},
): Promise<Harness> {
  const clock = new FakeClock(options.now);
  const core = new FakeCore();
  core.document = { v: 1, tasks: Object.fromEntries(records.map((record) => [record.id, record])) };
  const connection = new FakeConnection();
  const logger = new FakeLogger();
  let watcher: TaskWatcher | undefined;
  const store = TaskStore.create(core.call, clock, {
    liveTerminals: () => watcher?.liveTerminals(),
  });
  const releaseQueue: Array<() => void> = [];
  if (options.deferRefresh) {
    const refresh = store.refresh.bind(store);
    store.refresh = () =>
      new Promise<void>((resolve, reject) => {
        releaseQueue.push(() => {
          void refresh().then(resolve, reject);
        });
      });
  }
  watcher = new TaskWatcher({ connection, store, clock, logger });
  const transitions: TaskTransition[] = [];
  watcher.onTransition((transition) => transitions.push(transition));
  watcher.start();
  await drain();
  return {
    clock,
    core,
    connection,
    logger,
    store,
    transitions,
    watcher,
    async releaseRefresh() {
      releaseQueue.shift()?.();
      await drain();
    },
  };
}

function snapshot(h: Harness, terminals: Terminal[]): void {
  h.watcher.onSnapshot({ seq: 1, terminals });
}

function emit(h: Harness, type: string, address: string, data: unknown): void {
  h.watcher.onEvent({
    seq: 2,
    type,
    terminal: address,
    data: data as HcEvent["data"],
  });
}

function status(h: Harness, address: string, value: Status | null): void {
  emit(h, "status", address, { status: value, records: {}, reported: true });
}

function turn(h: Harness, address: string, value: number): void {
  emit(h, "turn", address, { turn: value });
}

function finished(h: Harness, address: string, code: number | null, keep = false): void {
  emit(h, keep ? "lost" : "finished", address, {
    reason: code === null ? "signaled" : "exited",
    exit_code: code,
    signal: null,
    ...(keep ? {} : { finished_ms: h.clock.now() }),
  });
}

async function settle(_h: Harness): Promise<void> {
  await drain();
  await drain();
}

async function writeAfter(h: Harness, ms = 300): Promise<void> {
  await h.clock.advance(ms);
  await settle(h);
}

describe("TaskWatcher order-independent transitions and outcomes", () => {
  test("attributes a done status to the turn the core reports next", async () => {
    const record = taskRecord(id("1"));
    const h = await harness([record]);
    snapshot(h, [terminal()]);
    await settle(h);

    status(h, "t1", { state: "done", msg: "Task finished." });
    turn(h, "t1", 1);
    expect(h.transitions.map(({ kind, turn: value }) => [kind, value])).toEqual([["done", 1]]);
    await writeAfter(h);
    finished(h, "t1", 7);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
      summary: "Task finished.",
    });
    expect(h.transitions).toHaveLength(1);
  });

  test("an observed working status at the persisted done turn supersedes persisted done", async () => {
    const record = taskRecord(id("2"), {
      outcome: { state: "done", turn: 1, ended: false, at: 90_000, summary: "Old result." },
    });
    const h = await harness([record]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "working" } })]);
    await settle(h);
    finished(h, "t1", 7);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 1,
      exit: { code: 7, reason: "exited" },
    });
  });

  test("settles the summary without a read when the program becomes a kept shell", async () => {
    const record = taskRecord(id("3"));
    const h = await harness([record]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(h);
    finished(h, "t1", 0, true);
    await settle(h);
    await h.clock.advance(1_000);
    await writeAfter(h);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
    });
  });

  test("keeps the done message when lost arrives before the flush", async () => {
    const record = taskRecord(id("4"));
    const h = await harness([record]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done", msg: "Captured before exit." });
    turn(h, "t1", 1);
    finished(h, "t1", 7, true);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
      summary: "Captured before exit.",
    });
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("keeps event dedupe memory when the refresh settles late", async () => {
    const record = taskRecord(id("5"));
    const h = await harness([record], { deferRefresh: true });
    snapshot(h, [terminal()]);
    status(h, "t1", { state: "done", msg: "One transition." });
    turn(h, "t1", 1);
    expect(h.transitions).toHaveLength(1);

    await settle(h);
    await h.releaseRefresh();
    await settle(h);
    await writeAfter(h);
    expect(h.transitions).toHaveLength(1);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("One transition.");
  });

  test("does not read or write for a matching persisted done without a summary", async () => {
    const record = taskRecord(id("6"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000 },
    });
    const h = await harness([record]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(h);
    await h.clock.advance(1_000);

    expect(h.core.sets).toHaveLength(0);
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("retries once two seconds after failure and never reads at the cap", async () => {
    const record = taskRecord(id("7"));
    const h = await harness([record]);
    let reads = 0;
    h.connection.readHandler = async () => {
      reads += 1;
      if (reads === 1) throw new Error("first read failed");
      return { complete: true, text: "Final response." };
    };
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(h);
    await h.clock.advance(750);
    await settle(h);
    expect(reads).toBe(1);
    await h.clock.advance(2_000);
    await settle(h);
    await writeAfter(h);
    expect(reads).toBe(2);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("Final response.");

    const capped = await harness([taskRecord(id("8"))]);
    let cappedReads = 0;
    capped.connection.readHandler = () => {
      cappedReads += 1;
      return new Promise((_, reject) => {
        capped.clock.setTimeout(() => reject(new Error("late failure")), 250);
      });
    };
    snapshot(capped, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(capped);
    await capped.clock.advance(750);
    await capped.clock.advance(250);
    await capped.clock.advance(2_000);
    await settle(capped);
    expect(cappedReads).toBe(1);
  });

  test("reads the codex summary with the codex foreground", async () => {
    const record = taskRecord(id("9"));
    const h = await harness([record]);
    h.connection.readHandler = async () => ({ complete: true, text: codexDoneScreen.join("\n") });
    snapshot(h, [
      terminal("t1", {
        argv: ["claude"],
        foreground: { pid: 24, name: "codex", argv: ["codex"], cwd: "/repo" },
        turn: 1,
        status: { state: "done" },
      }),
    ]);
    await settle(h);
    await h.clock.advance(750);
    await settle(h);
    await writeAfter(h);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe(
      "The focused model tests pass, with no protocol changes needed.",
    );
  });

  test("reads the claude summary with the claude foreground", async () => {
    const record = taskRecord(id("9"));
    const h = await harness([record]);
    h.connection.readHandler = async () => ({ complete: true, text: claudeDoneScreen.join("\n") });
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(h);
    await h.clock.advance(750);
    await settle(h);
    await writeAfter(h);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe(
      "All 27 focused tests pass, and workspace typecheck is clean.",
    );
  });

  test("emits one done at the completed turn for status then turn", async () => {
    const h = await harness([taskRecord(id("a"))]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done", msg: "Completed turn one." });
    turn(h, "t1", 1);

    expect(h.transitions.map(({ kind, turn: value, summary }) => [kind, value, summary])).toEqual([
      ["done", 1, "Completed turn one."],
    ]);
  });

  test("keeps needs-you memory through a snapshot restating blocked at turn one", async () => {
    const h = await harness([taskRecord(id("b"))]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "blocked", msg: "First question." });
    turn(h, "t1", 1);
    snapshot(h, [
      terminal("t1", { turn: 1, status: { state: "blocked", msg: "First question." } }),
    ]);

    expect(h.transitions.map(({ kind, turn: value }) => [kind, value])).toEqual([["needs-you", 1]]);
  });

  test("a second question after new work is a new turn and emits again", async () => {
    const h = await harness([taskRecord(id("b"))]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "blocked", msg: "First question." });
    turn(h, "t1", 1);
    snapshot(h, [
      terminal("t1", { turn: 1, status: { state: "blocked", msg: "First question." } }),
    ]);
    expect(h.transitions.map(({ kind, turn: value }) => [kind, value])).toEqual([["needs-you", 1]]);

    status(h, "t1", { state: "working" });
    status(h, "t1", { state: "blocked", msg: "Second question." });
    turn(h, "t1", 2);
    expect(h.transitions.map(({ kind, turn: value, question }) => [kind, value, question])).toEqual(
      [
        ["needs-you", 1, "First question."],
        ["needs-you", 2, "Second question."],
      ],
    );
  });

  test("re-marks silently when a late refresh restores persisted done; later labels emit nothing", async () => {
    const record = taskRecord(id("c"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000 },
    });
    const h = await harness([record], { deferRefresh: true });
    snapshot(h, [terminal()]);
    status(h, "t1", { state: "done", msg: "Delivered once." });
    turn(h, "t1", 1);
    await h.releaseRefresh();
    await settle(h);
    emit(h, "labels", "t1", { labels: { note: "changed" } });

    expect(h.transitions.map(({ kind, turn: value }) => [kind, value])).toEqual([["done", 1]]);
  });

  test.each([undefined, "Outdated summary."])(
    "writes a new same-turn done message without a read when the old summary is %s",
    async (previousSummary) => {
      const record = taskRecord(id("d"), {
        outcome: {
          state: "done",
          turn: 1,
          ended: false,
          at: 99_000,
          ...(previousSummary === undefined ? {} : { summary: previousSummary }),
        },
      });
      const h = await harness([record]);
      snapshot(h, [terminal()]);
      await settle(h);
      status(h, "t1", { state: "done", msg: "New same-turn message." });
      turn(h, "t1", 1);
      await writeAfter(h);

      expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
        state: "done",
        turn: 1,
        summary: "New same-turn message.",
      });
      expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    },
  );

  test("metadata before a late refresh does not supersede a persisted done", async () => {
    const record = taskRecord(id("e"), {
      outcome: { state: "done", turn: 1, ended: true, at: 99_000, summary: "Saved." },
    });
    const h = await harness([record], { deferRefresh: true });
    snapshot(h, [
      terminal("t1", { state: "finished", pid: null, status: null, turn: 1, exit_code: 0 }),
    ]);
    await settle(h);
    emit(h, "title", "t1", { title: "Renamed" });
    await h.releaseRefresh();
    await settle(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("Saved.");
    expect(h.core.sets).toHaveLength(0);
  });

  test("a snapshot of the ended terminal does not resurrect a superseded done", async () => {
    const record = taskRecord(id("f"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000, summary: "Old." },
    });
    const h = await harness([record]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "working" } })]);
    await settle(h);
    finished(h, "t1", 7);
    snapshot(h, [
      terminal("t1", {
        state: "finished",
        turn: 1,
        status: null,
        exit_code: 7,
        reason: "exited",
        finished_ms: 100_100,
      }),
    ]);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 1,
      exit: { code: 7 },
    });
  });

  test("emits one needs-you at the completed turn", async () => {
    const h = await harness();
    snapshot(h, [terminal()]);
    status(h, "t1", { state: "blocked", msg: "Approve the change?" });
    turn(h, "t1", 1);

    expect(h.transitions.map(({ kind, turn: value, question }) => [kind, value, question])).toEqual(
      [["needs-you", 1, "Approve the change?"]],
    );
  });

  test("writes a new done message delivered by snapshot", async () => {
    const record = taskRecord(id("g"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000, summary: "Outdated." },
    });
    const h = await harness([record]);
    snapshot(h, [
      terminal("t1", { turn: 1, status: { state: "done", msg: "New snapshot message." } }),
    ]);
    await settle(h);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("New snapshot message.");
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("a snapshot restating done needs no turn event", async () => {
    const record = taskRecord(id("h"));
    const h = await harness([record]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done", msg: "Snapshot then turn." });
    snapshot(h, [
      terminal("t1", { turn: 1, status: { state: "done", msg: "Snapshot then turn." } }),
    ]);
    await writeAfter(h);

    expect(h.transitions.map(({ kind, turn: value }) => [kind, value])).toEqual([["done", 1]]);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      summary: "Snapshot then turn.",
    });
  });

  test("metadata after a silent snapshot completion emits nothing", async () => {
    const h = await harness([taskRecord(id("i"))]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done", msg: "Quiet." } })]);
    await settle(h);
    emit(h, "labels", "t1", { labels: { color: "blue" } });

    expect(h.transitions).toHaveLength(0);
  });

  test.each([
    [
      "ended idle with non-zero exit",
      terminal("t1", { state: "finished", turn: 1, status: null, exit_code: 7 }),
      7,
      "stopped",
    ],
    [
      "idle then zero exit",
      terminal("t1", { state: "finished", turn: 1, status: null, exit_code: 0 }),
      0,
      "done",
    ],
  ] as const)("classifies %s", async (_label, view, code, expected) => {
    const record = taskRecord(id("j"));
    const h = await harness([record]);
    snapshot(h, [view]);
    await settle(h);
    if (expected === "done") await h.clock.advance(750);
    await writeAfter(h);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.state).toBe(expected);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.exit?.code).toBe(
      expected === "done" ? undefined : code,
    );
  });

  test("live idle at turn one then exit seven is stopped", async () => {
    const record = taskRecord(id("j"));
    const h = await harness([record]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "idle" } })]);
    await settle(h);
    finished(h, "t1", 7);
    await writeAfter(h);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 1,
      exit: { code: 7 },
    });
  });

  test("ignores a stale done during a follow-up turn and rewrites after the next done", async () => {
    const record = taskRecord(id("k"));
    const h = await harness([record]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done", msg: "First turn." });
    turn(h, "t1", 1);
    await writeAfter(h);

    status(h, "t1", { state: "working" });
    await writeAfter(h);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      summary: "First turn.",
    });

    status(h, "t1", { state: "done", msg: "Second turn." });
    turn(h, "t1", 2);
    await writeAfter(h);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 2,
      summary: "Second turn.",
    });
  });

  test("a status change before 750 ms makes zero reads", async () => {
    const h = await harness([taskRecord(id("k"))]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(h);
    status(h, "t1", { state: "working" });
    await h.clock.advance(1_000);
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("stop() with scheduled and in-flight reads applies nothing", async () => {
    const scheduled = await harness([taskRecord(id("l"))]);
    snapshot(scheduled, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(scheduled);
    await scheduled.watcher.stop();
    await scheduled.clock.advance(1_000);
    expect(
      scheduled.connection.calls.filter((call) => call.method === "terminal.read"),
    ).toHaveLength(0);
    expect(scheduled.core.sets).toHaveLength(0);

    const inflight = await harness([taskRecord(id("m"))]);
    let resolveRead: ((value: unknown) => void) | undefined;
    inflight.connection.readHandler = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    snapshot(inflight, [terminal("t1", { turn: 1, status: { state: "done" } })]);
    await settle(inflight);
    await inflight.clock.advance(750);
    await settle(inflight);
    expect(
      inflight.connection.calls.filter((call) => call.method === "terminal.read"),
    ).toHaveLength(1);
    await inflight.watcher.stop();
    resolveRead?.({ complete: true, text: "Too late." });
    await settle(inflight);
    expect(inflight.core.sets).toHaveLength(0);
  });

  test("ignores a stale read while a newer turn read is in flight", async () => {
    const record = taskRecord(id("n"));
    const h = await harness([record]);
    const pending: Array<(value: unknown) => void> = [];
    h.connection.readHandler = () =>
      new Promise((resolve) => {
        pending.push(resolve);
      });
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done" });
    turn(h, "t1", 1);
    await h.clock.advance(750);
    await settle(h);

    status(h, "t1", { state: "working" });
    status(h, "t1", { state: "done" });
    turn(h, "t1", 2);
    await h.clock.advance(750);
    await settle(h);
    expect(pending).toHaveLength(2);
    pending[0]?.({ complete: true, text: "Screen from turn one." });
    await settle(h);
    pending[1]?.({ complete: true, text: "Screen from turn two." });
    await settle(h);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 2,
      summary: "Screen from turn two.",
    });
  });

  test("stores stopped details for a non-zero exit and stopped for a missing terminal", async () => {
    const exited = taskRecord(id("o"));
    const missing = taskRecord(id("p"), { terminal: "t2" });
    const h = await harness([exited, missing]);
    snapshot(h, [terminal("t1")]);
    await settle(h);
    finished(h, "t1", 9);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[exited.id]?.outcome).toMatchObject({
      state: "stopped",
      exit: { code: 9, signal: null, reason: "exited" },
    });
    expect(h.store.snapshot().tasks[missing.id]?.outcome).toMatchObject({ state: "stopped" });
  });

  test("does not write outcomes for running or blocked tasks", async () => {
    const h = await harness([taskRecord(id("q"))]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "blocked", msg: "No document outcome." });
    turn(h, "t1", 1);
    await h.clock.advance(1_000);

    expect(h.core.sets).toHaveLength(0);
    expect(h.transitions[0]?.question).toBe("No document outcome.");
  });

  test("uses successful exit as done evidence and avoids reading a kept shell", async () => {
    const exited = taskRecord(id("r"));
    const kept = taskRecord(id("s"), { terminal: "t-kept" });
    const h = await harness([exited, kept]);
    snapshot(h, [
      terminal("t1", { state: "finished", turn: 1, status: null, exit_code: 0, reason: "exited" }),
      terminal("t-kept", { turn: 1, status: null, reason: "exited" }),
    ]);
    await settle(h);
    await h.clock.advance(750);
    await writeAfter(h);

    expect(h.store.snapshot().tasks[exited.id]?.outcome?.state).toBe("done");
    expect(h.store.snapshot().tasks[kept.id]?.outcome).toMatchObject({
      state: "stopped",
      ended: true,
    });
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);
  });

  test("preserves done evidence when the terminal is removed before its summary read", async () => {
    const record = taskRecord(id("t"));
    const h = await harness([record]);
    snapshot(h, [terminal()]);
    await settle(h);
    status(h, "t1", { state: "done", msg: "Kept in memory." });
    turn(h, "t1", 1);
    emit(h, "removed", "t1", {});
    await writeAfter(h);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      ended: true,
      summary: "Kept in memory.",
    });
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("matches unlinked records using record.createdAt and ignores already claimed addresses", async () => {
    const claimed = taskRecord(id("u"), { createdAt: 80_000 });
    const unlinked = taskRecord(id("v"), { terminal: undefined, createdAt: 80_000 });
    const h = await harness([claimed, unlinked]);
    snapshot(h, [terminal("t1", { created_ms: 80_000 }), terminal("t2", { created_ms: 80_000 })]);
    await settle(h);

    expect(h.store.snapshot().tasks[claimed.id]?.terminal).toBe("t1");
    expect(h.store.snapshot().tasks[unlinked.id]?.terminal).toBe("t2");
  });

  test("swallows a task_linked race while matching an unlinked record", async () => {
    const record = taskRecord(id("w"), { terminal: undefined });
    const h = await harness([record]);
    h.store.link = async () => {
      throw new TaskStoreError("task_linked");
    };
    snapshot(h, [terminal("t1")]);
    await settle(h);

    expect(h.logger.entries.some((entry) => entry.fields?.code === "task_linked")).toBe(false);
    expect(h.store.snapshot().tasks[record.id]?.terminal).toBeUndefined();
  });

  test("coalesces multiple dirty outcomes into one document write", async () => {
    const first = taskRecord(id("x"));
    const second = taskRecord(id("y"), { terminal: "t2" });
    const h = await harness([first, second]);
    snapshot(h, [
      terminal("t1", { turn: 1, status: { state: "done", msg: "First." } }),
      terminal("t2", { turn: 2, status: { state: "done", msg: "Second." } }),
    ]);
    await settle(h);
    await writeAfter(h);

    expect(h.core.sets).toHaveLength(1);
    expect(h.store.snapshot().tasks[first.id]?.outcome?.summary).toBe("First.");
    expect(h.store.snapshot().tasks[second.id]?.outcome?.summary).toBe("Second.");
  });

  test("retries document conflicts after five seconds, caps retries, and waits for a change", async () => {
    const record = taskRecord(id("z"));
    const h = await harness([record]);
    h.core.conflicts = 2;
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done", msg: "Conflict task." } })]);
    await settle(h);
    await h.clock.advance(300);
    await settle(h);
    expect(h.core.sets).toHaveLength(2);
    await h.clock.advance(4_999);
    expect(h.core.sets).toHaveLength(2);
    await h.clock.advance(1);
    await settle(h);
    expect(h.core.sets).toHaveLength(4);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("Conflict task.");

    const stuck = await harness([taskRecord(id("1"))]);
    stuck.core.conflicts = 50;
    snapshot(stuck, [terminal("t1", { turn: 1, status: { state: "done", msg: "Repeated." } })]);
    await settle(stuck);
    await stuck.clock.advance(300);
    await settle(stuck);
    await stuck.clock.advance(15_000);
    const attemptsAfterCap = stuck.core.sets.length;
    expect(attemptsAfterCap).toBe(8);
    expect(stuck.watcher.status().pendingWrites).toBe(1);
    stuck.core.conflicts = 0;
    emit(stuck, "labels", "t1", { labels: { note: "new fact" } });
    await writeAfter(stuck);
    expect(stuck.store.snapshot().tasks[id("1")]?.outcome?.summary).toBe("Repeated.");
  });

  test("logs tasks_full without task content and drops the pending flush until a change", async () => {
    const record = taskRecord(id("2"));
    const h = await harness([record]);
    h.core.writeError = new TaskStoreError("tasks_full");
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done", msg: "Private summary" } })]);
    await settle(h);
    await h.clock.advance(300);
    await settle(h);

    expect(h.watcher.status().pendingWrites).toBe(0);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toBeUndefined();
    expect(h.logger.entries.some((entry) => entry.fields?.code === "tasks_full")).toBe(true);
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE TASK TEXT");
    expect(JSON.stringify(h.logger.entries)).not.toContain("Private summary");
  });

  test("contains a throwing sink and keeps task text out of logs", async () => {
    const h = await harness([taskRecord(id("3"))]);
    h.watcher.onTransition(() => {
      throw new Error("sink failed");
    });
    snapshot(h, [terminal()]);
    status(h, "t1", { state: "blocked", msg: "PRIVATE QUESTION" });
    status(h, "t1", { state: "working" });
    status(h, "t1", { state: "done", msg: "PRIVATE SUMMARY" });
    turn(h, "t1", 2);

    expect(h.transitions.map(({ kind }) => kind)).toEqual(["needs-you", "done"]);
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE QUESTION");
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE SUMMARY");
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE TASK TEXT");
    expect(h.logger.entries.some((entry) => entry.fields?.code === "transition_sink")).toBe(true);
  });

  test("ignores remote terminals and reports liveness, counts, and resume forwarding", async () => {
    const local = taskRecord(id("4"));
    const remote = taskRecord(id("5"), { terminal: "box/t7" });
    const h = await harness([local, remote]);
    snapshot(h, [terminal("t1"), terminal("box/t7")]);
    await settle(h);
    status(h, "box/t7", { state: "done", msg: "remote" });

    expect(h.watcher.status()).toMatchObject({ state: "live", terminals: 1, tracked: 1 });
    expect([...(h.watcher.liveTerminals() ?? [])]).toEqual(["t1"]);
    h.watcher.resume();
    expect(h.connection.resumes).toBe(1);
    h.connection.state = { ...h.connection.state, state: "backoff" };
    expect(h.watcher.liveTerminals()).toBeUndefined();
    h.watcher.onConnectionState({ ...h.connection.state, state: "live" });
  });

  test("uses the live gate to retry pending writes when the connection returns", async () => {
    const record = taskRecord(id("6"));
    const h = await harness([record]);
    h.connection.state = { ...h.connection.state, state: "backoff" };
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done", msg: "After reconnect." } })]);
    await settle(h);
    await h.clock.advance(300);
    expect(h.core.sets).toHaveLength(0);
    h.connection.state = { ...h.connection.state, state: "live" };
    h.watcher.onConnectionState(h.connection.state);
    await writeAfter(h);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("After reconnect.");
  });

  test("stop cancels a scheduled outcome flush", async () => {
    const h = await harness([taskRecord(id("7"))]);
    snapshot(h, [terminal("t1", { turn: 1, status: { state: "done", msg: "Soon." } })]);
    await settle(h);
    expect(h.watcher.status().pendingWrites).toBe(1);
    await h.watcher.stop();
    await h.clock.advance(500);
    expect(h.connection.stops).toBe(1);
    expect(h.core.sets).toHaveLength(0);
    expect(h.watcher.status().pendingWrites).toBe(0);
  });
});
