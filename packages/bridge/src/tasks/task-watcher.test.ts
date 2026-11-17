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
import {
  desiredOutcome,
  type TaskTransition,
  TaskWatcher,
  type TaskWatcherLogger,
  type TrackedTask,
  transitionOf,
} from "./task-watcher.ts";

class FakeClock implements Clock {
  nowValue = 100_000;
  nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

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
    const target = this.nowValue + ms;
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
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

class FakeCore {
  document: TasksDocument = { v: 1, tasks: {} };
  version = 3;
  lists = 0;
  conflicts = 0;
  readFailure: Error | undefined;
  listTerminals: Terminal[] = [];
  readonly calls: HcMethod[] = [];
  readonly sets: Array<{ version: number; value: TasksDocument }> = [];

  readonly call: TaskCoreCaller = async (method, params) => {
    this.calls.push(method as HcMethod);
    if (method === "doc.get") {
      if (this.readFailure) throw this.readFailure;
      expect(params).toEqual({ name: "herdr-mobile.tasks" });
      return { value: structuredClone(this.document), version: this.version };
    }
    if (method === "terminal.list") {
      this.lists += 1;
      return { terminals: structuredClone(this.listTerminals) };
    }
    if (method !== "doc.set") throw new Error(`unexpected core method ${method}`);
    const input = params as { version: number; value: TasksDocument };
    this.sets.push({ version: input.version, value: structuredClone(input.value) });
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
  readHandler: (() => Promise<unknown>) | undefined;

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
    if (method === "terminal.read" && this.readHandler) return this.readHandler();
    if (method === "terminal.read") {
      return { complete: true, how: "screen", text: "Finished successfully." };
    }
    throw new Error(`unexpected watcher call ${method}`);
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

const id = (digit: string): string => `tk${digit.repeat(32)}`;

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
    turn: 1,
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
  releaseRefresh?: () => void;
}

async function harness(
  tasks: TaskRecord[] = [],
  options: { deferRefresh?: boolean } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const core = new FakeCore();
  core.document = { v: 1, tasks: Object.fromEntries(tasks.map((record) => [record.id, record])) };
  const connection = new FakeConnection();
  const logger = new FakeLogger();
  let watcher: TaskWatcher | undefined;
  const store = TaskStore.create(core.call, clock, {
    liveTerminals: () => watcher?.liveTerminals(),
  });
  let releaseRefresh: (() => void) | undefined;
  if (options.deferRefresh) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRefresh = store.refresh.bind(store);
    store.refresh = async () => {
      await gate;
      await originalRefresh();
    };
    releaseRefresh = () => release?.();
  }
  watcher = new TaskWatcher({ connection, store, clock, logger });
  const transitions: TaskTransition[] = [];
  watcher.onTransition((transition) => transitions.push(transition));
  watcher.start();
  await drain();
  return { clock, core, connection, logger, store, transitions, watcher, releaseRefresh };
}

function trackedTask(changes: Partial<TrackedTask> = {}): TrackedTask {
  return {
    address: "t1",
    terminal: terminal(),
    inTable: true,
    task: taskRecord(id("9")),
    status: { state: "working" },
    statusTurn: 1,
    reported: true,
    ended: false,
    eventSinceSnapshot: false,
    eventSupersededOutcome: false,
    createdAt: 100_000,
    ...changes,
  };
}

function snapshot(watcher: TaskWatcher, terminals: Terminal[]): void {
  watcher.onSnapshot({ seq: 1, terminals });
}

function event(
  watcher: TaskWatcher,
  type: string,
  address: string | undefined,
  data: unknown,
): void {
  watcher.onEvent({
    seq: 2,
    type,
    ...(address === undefined ? {} : { terminal: address }),
    data: data as HcEvent["data"],
  });
}

function statusEvent(watcher: TaskWatcher, address: string, status: Status | null): void {
  event(watcher, "status", address, { status, records: {}, reported: true });
}

describe("TaskWatcher derivations", () => {
  test.each([
    {
      label: "working live terminal",
      tracked: trackedTask(),
      outcome: undefined,
      transition: undefined,
    },
    {
      label: "attributed done completion",
      tracked: trackedTask({
        status: { state: "done", msg: "Finished." },
        completion: {
          generation: 1,
          status: { state: "done", msg: "Finished." },
          message: "Finished.",
          turn: 1,
          pending: false,
          attributedAt: 100_010,
          source: "event",
        },
      }),
      outcome: { state: "done", turn: 1, ended: false, at: 100_010, summary: "Finished." },
      transition: { kind: "done", turn: 1 },
    },
    {
      label: "pending done completion",
      tracked: trackedTask({
        status: { state: "done", msg: "Finished." },
        completion: {
          generation: 1,
          status: { state: "done", msg: "Finished." },
          message: "Finished.",
          turn: 0,
          pending: true,
          source: "event",
        },
      }),
      outcome: undefined,
      transition: undefined,
    },
    {
      label: "ended without done evidence",
      tracked: trackedTask({
        terminal: terminal("t1", {
          state: "finished",
          reason: "exited",
          exit_code: 7,
          status: { state: "working" },
        }),
        status: { state: "working" },
        ended: true,
        endedAt: 100_020,
      }),
      outcome: {
        state: "stopped",
        turn: 1,
        ended: true,
        at: 100_020,
        exit: { code: 7, signal: null, reason: "exited" },
      },
      transition: { kind: "stopped", turn: 1 },
    },
    {
      label: "needs-you status",
      tracked: trackedTask({ status: { state: "blocked", msg: "Choose." } }),
      outcome: undefined,
      transition: { kind: "needs-you", turn: 1 },
    },
  ])("derives $label from one tracked record", ({ tracked, outcome, transition }) => {
    expect(desiredOutcome(tracked)).toEqual(outcome);
    expect(transitionOf(tracked)).toEqual(transition);
  });
});

describe("TaskWatcher", () => {
  test("refreshes existing records on bridge restart and stores a status summary", async () => {
    const record = taskRecord(id("1"));
    const h = await harness([record]);
    expect(h.store.snapshot().tasks[record.id]).toEqual(record);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toBeUndefined();
    expect(h.core.sets).toHaveLength(0);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "Task finished." } })]);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: false,
      summary: "Task finished.",
    });
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    expect(h.core.sets).toHaveLength(1);
  });

  test("does not reopen a matching settled done outcome without a summary", async () => {
    const record = taskRecord(id("1"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000 },
    });
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(10_000);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    expect(h.core.sets).toHaveLength(0);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toEqual(record.outcome);
  });

  test.each([undefined, "Outdated summary."])(
    "writes a new same-turn done message without reading after a settled summary of %s",
    async (previousSummary) => {
      const outcome = {
        state: "done" as const,
        turn: 1,
        ended: false,
        at: 99_000,
        ...(previousSummary === undefined ? {} : { summary: previousSummary }),
      };
      const record = taskRecord(id("1"), { outcome });
      const h = await harness([record]);
      snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
      await drain();
      await h.clock.advance(1_000);
      expect(h.core.sets).toHaveLength(0);

      statusEvent(h.watcher, "t1", { state: "done", msg: "New same-turn message." });
      await drain();
      await h.clock.advance(300);

      expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
        state: "done",
        turn: 1,
        summary: "New same-turn message.",
      });
      expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
      expect(h.core.sets).toHaveLength(1);
    },
  );

  test("keeps transition dedupe memory when snapshot refresh finishes after events", async () => {
    const h = await harness();
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const originalRefresh = h.store.refresh.bind(h.store);
    h.store.refresh = async () => {
      await refreshGate;
      await originalRefresh();
    };

    snapshot(h.watcher, [terminal("t1", { status: { state: "working" } })]);
    await drain();
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Choose one." });
    statusEvent(h.watcher, "t1", { state: "working" });
    await drain();
    releaseRefresh?.();
    await drain();
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Choose one." });
    await drain();

    expect(h.transitions.filter((transition) => transition.kind === "needs-you")).toHaveLength(1);
  });

  test("keeps needs-you dedupe through a missed snapshot", async () => {
    const h = await harness();
    snapshot(h.watcher, [terminal("t1", { status: { state: "working" } })]);
    await drain();
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Choose one." });
    statusEvent(h.watcher, "t1", { state: "working" });
    await drain();

    event(h.watcher, "missed", undefined, {
      seq: 9,
      terminals: [terminal("t1", { status: { state: "working" } })],
    });
    await drain();
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Choose one." });
    await drain();

    expect(h.transitions.map(({ kind, turn }) => [kind, turn])).toEqual([["needs-you", 1]]);
  });

  test("does not emit a historical transition when delayed refresh restores the baseline", async () => {
    const record = taskRecord(id("f"), {
      outcome: { state: "done", turn: 1, ended: true, at: 99_000 },
    });
    const h = await harness([record], { deferRefresh: true });
    snapshot(h.watcher, [
      terminal("t1", {
        state: "finished",
        reason: "exited",
        exit_code: 7,
        status: null,
      }),
    ]);
    await drain();
    expect(h.transitions).toHaveLength(0);

    h.releaseRefresh?.();
    await drain();
    expect(h.transitions).toHaveLength(0);
    event(h.watcher, "labels", "t1", { labels: { note: "refreshed" } });
    await drain();

    expect(h.transitions).toHaveLength(0);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toEqual(record.outcome);
  });

  test.each([
    ["claude", claudeDoneScreen],
    ["codex", codexDoneScreen],
  ] as const)("reads the %s summary after the 750 ms settle delay", async (program, rows) => {
    const record = taskRecord(id(program === "claude" ? "2" : "3"), {
      run: { kind: "program", id: program },
    });
    const h = await harness([record]);
    const screenRows = program === "codex" ? [...rows, "", "• Adapter check: Codex."] : rows;
    h.connection.readHandler = async () => ({
      complete: true,
      how: "screen",
      text: screenRows.join("\n"),
    });
    snapshot(h.watcher, [
      terminal("t1", {
        argv: [program],
        foreground: {
          pid: 23,
          name: program,
          argv: [program],
          cwd: "/repo",
        },
        status: { state: "done" },
      }),
    ]);
    await drain();
    await h.clock.advance(749);
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe(
      program === "claude"
        ? "All 27 focused tests pass, and workspace typecheck is clean."
        : "Adapter check: Codex.",
    );
  });

  test("associates a done status with the turn that follows it", async () => {
    const record = taskRecord(id("b"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    statusEvent(h.watcher, "t1", { state: "done", msg: "Completed turn one." });
    expect(h.transitions).toHaveLength(0);
    event(h.watcher, "missed", undefined, {
      seq: 3,
      terminals: [
        terminal("t1", { turn: 0, status: { state: "done", msg: "Completed turn one." } }),
      ],
    });
    await drain();
    expect(h.transitions).toHaveLength(0);
    event(h.watcher, "turn", "t1", { turn: 1 });
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      summary: "Completed turn one.",
    });
    expect(h.transitions.map(({ kind, turn, summary }) => [kind, turn, summary])).toEqual([
      ["done", 1, "Completed turn one."],
    ]);
  });

  test("keeps a snapshot-observed working-to-done change pending for its turn event", async () => {
    const record = taskRecord(id("b"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    snapshot(h.watcher, [
      terminal("t1", { turn: 0, status: { state: "done", msg: "Snapshot then turn." } }),
    ]);
    await drain();
    expect(h.transitions).toHaveLength(0);
    event(h.watcher, "turn", "t1", { turn: 1 });
    await drain();
    await h.clock.advance(300);

    expect(h.transitions.map(({ kind, turn, summary }) => [kind, turn, summary])).toEqual([
      ["done", 1, "Snapshot then turn."],
    ]);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      summary: "Snapshot then turn.",
    });
  });

  test("attributes turn-before-status to the already reported turn", async () => {
    const record = taskRecord(id("0"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    event(h.watcher, "turn", "t1", { turn: 1 });
    statusEvent(h.watcher, "t1", { state: "done", msg: "Turn first, status second." });
    await drain();
    await h.clock.advance(300);

    expect(h.transitions.map(({ kind, turn }) => [kind, turn])).toEqual([["done", 1]]);
    expect(h.transitions[0]?.summary).toBe("Turn first, status second.");
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      summary: "Turn first, status second.",
    });
  });

  test("attributes done to the current turn after 500 ms when no turn event arrives", async () => {
    const record = taskRecord(id("0"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    statusEvent(h.watcher, "t1", { state: "done", msg: "No turn event." });
    await drain();
    await h.clock.advance(499);
    expect(h.transitions).toHaveLength(0);
    expect(h.core.sets).toHaveLength(0);
    await h.clock.advance(1);
    await h.clock.advance(300);

    expect(h.transitions.map(({ kind, turn }) => [kind, turn])).toEqual([["done", 0]]);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 0,
      summary: "No turn event.",
    });
  });

  test("attributes a pending completion when the terminal ends before the turn event", async () => {
    const record = taskRecord(id("0"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    statusEvent(h.watcher, "t1", { state: "done", msg: "Finished before its turn report." });
    expect(h.transitions).toHaveLength(0);
    event(h.watcher, "lost", "t1", { reason: "exited", exit_code: 7, signal: null });
    await drain();
    await h.clock.advance(300);

    expect(h.transitions.map(({ kind, turn, summary }) => [kind, turn, summary])).toEqual([
      ["done", 0, "Finished before its turn report."],
    ]);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 0,
      ended: true,
      summary: "Finished before its turn report.",
    });
  });

  test("keeps status-then-turn done evidence when the terminal later exits non-zero", async () => {
    const record = taskRecord(id("c"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { turn: 0, status: { state: "working" } })]);
    await drain();

    statusEvent(h.watcher, "t1", { state: "done", msg: "Completed before exit." });
    event(h.watcher, "turn", "t1", { turn: 1 });
    event(h.watcher, "finished", "t1", {
      reason: "exited",
      exit_code: 7,
      signal: null,
      finished_ms: h.clock.now(),
    });
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
      summary: "Completed before exit.",
    });
  });

  test("a newer working observation supersedes persisted done evidence", async () => {
    const record = taskRecord(id("d"), {
      outcome: { state: "done", turn: 1, ended: false, at: 99_000, summary: "Old result." },
    });
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "Old result." } })]);
    await drain();

    statusEvent(h.watcher, "t1", { state: "working" });
    event(h.watcher, "finished", "t1", {
      reason: "exited",
      exit_code: 7,
      signal: null,
      finished_ms: h.clock.now(),
    });
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 1,
      ended: true,
      exit: { code: 7, reason: "exited" },
    });
    expect(h.transitions.at(-1)?.kind).toBe("stopped");
  });

  test("stores stopped details for a non-zero terminal and stopped for a missing terminal", async () => {
    const exited = taskRecord(id("4"), { terminal: "t-exited" });
    const missing = taskRecord(id("5"), { terminal: "t-missing" });
    const h = await harness([exited, missing]);
    snapshot(h.watcher, [
      terminal("t-exited", { state: "finished", reason: "exited", exit_code: 7, status: null }),
    ]);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[exited.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 1,
      ended: true,
      exit: { code: 7, signal: null, reason: "exited" },
    });
    expect(h.store.snapshot().tasks[missing.id]?.outcome).toMatchObject({
      state: "stopped",
      turn: 0,
      ended: true,
    });
    expect(h.store.snapshot().tasks[missing.id]?.outcome).not.toHaveProperty("exit");
  });

  test("does not write outcomes for running or blocked tasks", async () => {
    const running = taskRecord(id("6"), { terminal: "t-running" });
    const blocked = taskRecord(id("7"), { terminal: "t-blocked" });
    const h = await harness([running, blocked]);
    snapshot(h.watcher, [
      terminal("t-running", { status: { state: "working" } }),
      terminal("t-blocked", { status: { state: "blocked", msg: "Need your choice" } }),
    ]);
    await drain();
    await h.clock.advance(1_000);

    expect(h.store.snapshot().tasks[running.id]?.outcome).toBeUndefined();
    expect(h.store.snapshot().tasks[blocked.id]?.outcome).toBeUndefined();
    expect(h.core.sets).toHaveLength(0);
  });

  test("uses successful exit as done evidence and avoids reading a kept shell", async () => {
    const exited = taskRecord(id("8"), { terminal: "t-exit" });
    const kept = taskRecord(id("9"), {
      terminal: "t-kept",
      outcome: { state: "done", turn: 1, ended: false, at: 99_000, summary: "Saved summary." },
    });
    const h = await harness([exited, kept]);
    snapshot(h.watcher, [
      terminal("t-exit", { state: "finished", reason: "exited", exit_code: 0, status: null }),
      terminal("t-kept", {
        state: "live",
        reason: "exited",
        exit_code: null,
        status: { state: "done", msg: "Shell output." },
      }),
    ]);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[kept.id]?.outcome).toMatchObject({
      state: "done",
      ended: true,
      summary: "Saved summary.",
    });
    await h.clock.advance(750);
    await h.clock.advance(300);
    expect(h.store.snapshot().tasks[exited.id]?.outcome).toMatchObject({
      state: "done",
      ended: true,
    });
    expect(
      h.connection.calls
        .filter((call) => call.method === "terminal.read")
        .map((call) => (call.params as { terminal: string }).terminal),
    ).toEqual(["t-exit"]);
  });

  test("retries a failed summary read once after two seconds and then writes", async () => {
    const record = taskRecord(id("a"));
    const h = await harness([record]);
    let reads = 0;
    h.connection.readHandler = async () => {
      reads += 1;
      if (reads === 1) throw new Error("read failed");
      return { complete: false, how: "screen", text: "Final response." };
    };
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    expect(reads).toBe(1);
    await h.clock.advance(1_999);
    expect(reads).toBe(1);
    await h.clock.advance(1);
    expect(reads).toBe(2);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("Final response.");
  });

  test("writes done without a summary after both reads fail", async () => {
    const record = taskRecord(id("a"));
    const h = await harness([record]);
    let reads = 0;
    h.connection.readHandler = async () => {
      reads += 1;
      throw new Error("terminal read unavailable");
    };
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    await h.clock.advance(2_000);
    await h.clock.advance(300);

    expect(reads).toBe(2);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
    });
    expect(h.store.snapshot().tasks[record.id]?.outcome).not.toHaveProperty("summary");
  });

  test("caps an unresolved summary read at three seconds", async () => {
    const record = taskRecord(id("b"));
    const h = await harness([record]);
    h.connection.readHandler = () => new Promise(() => {});
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    await h.clock.advance(2_250);
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
    });
    expect(h.store.snapshot().tasks[record.id]?.outcome).not.toHaveProperty("summary");
  });

  test("does not retry a read when the two-second delay reaches the summary cap", async () => {
    const record = taskRecord(id("e"));
    const h = await harness([record]);
    let reads = 0;
    let failRead: ((error: Error) => void) | undefined;
    h.connection.readHandler = () => {
      reads += 1;
      return new Promise((_, reject) => {
        failRead = reject;
      });
    };
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    expect(reads).toBe(1);
    await h.clock.advance(1_250);
    failRead?.(new Error("read failed at 2 s"));
    await drain();

    await h.clock.advance(999);
    expect(reads).toBe(1);
    await h.clock.advance(1);
    expect(reads).toBe(1);
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
    });
    expect(h.store.snapshot().tasks[record.id]?.outcome).not.toHaveProperty("summary");
    expect(reads).toBe(1);
  });

  test("cancels a pending screen read when a new status arrives", async () => {
    const record = taskRecord(id("c"));
    const h = await harness([record]);
    h.connection.readHandler = () => new Promise(() => {});
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    statusEvent(h.watcher, "t1", { state: "working" });
    await drain();
    await h.clock.advance(2_250);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toBeUndefined();
  });

  test("preserves done evidence when the terminal is removed before its summary read", async () => {
    const record = taskRecord(id("c"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(500);
    event(h.watcher, "removed", "t1", {});
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
    });
    expect(h.store.snapshot().tasks[record.id]?.outcome).not.toHaveProperty("summary");
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
  });

  test("cancels a scheduled summary read when a terminal becomes a kept shell", async () => {
    const record = taskRecord(id("f"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(100);
    event(h.watcher, "lost", "t1", {
      reason: null,
      exit_code: null,
      signal: null,
    });
    await drain();
    await h.clock.advance(2_900);

    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(0);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
    });
  });

  test("ignores an in-flight screen result after the terminal becomes a kept shell", async () => {
    const record = taskRecord(id("f"));
    const h = await harness([record]);
    let resolveRead: ((value: unknown) => void) | undefined;
    h.connection.readHandler = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    snapshot(h.watcher, [terminal("t1", { status: { state: "done" } })]);
    await drain();
    await h.clock.advance(750);
    expect(h.connection.calls.filter((call) => call.method === "terminal.read")).toHaveLength(1);

    event(h.watcher, "lost", "t1", { reason: null, exit_code: null, signal: null });
    await drain();
    resolveRead?.({ complete: true, how: "screen", text: "Shell output after the program ended." });
    await drain();
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
    });
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBeUndefined();
  });

  test("keeps a done status message when a kept shell arrives before the write", async () => {
    const record = taskRecord(id("1"));
    const h = await harness([record]);
    snapshot(h.watcher, [
      terminal("t1", { status: { state: "done", msg: "Saved before shell." } }),
    ]);
    await drain();
    await h.clock.advance(100);
    event(h.watcher, "lost", "t1", {
      reason: "exited",
      exit_code: null,
      signal: null,
    });
    await drain();
    expect(h.core.sets).toHaveLength(0);
    await h.clock.advance(200);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 1,
      ended: true,
      summary: "Saved before shell.",
    });
    expect(h.core.sets).toHaveLength(1);
  });

  test("ignores a stale done status during a follow-up turn and rewrites after the next done", async () => {
    const record = taskRecord(id("d"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "First turn." } })]);
    await drain();
    await h.clock.advance(300);
    const setCount = h.core.sets.length;

    event(h.watcher, "turn", "t1", { turn: 2 });
    await drain();
    await h.clock.advance(1_000);
    expect(h.core.sets).toHaveLength(setCount);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.turn).toBe(1);

    statusEvent(h.watcher, "t1", { state: "done", msg: "Second turn." });
    await drain();
    await h.clock.advance(300);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      turn: 2,
      summary: "Second turn.",
    });
  });

  test("applies terminal events when a linked record appears later", async () => {
    const h = await harness();
    snapshot(h.watcher, [terminal("t1", { status: { state: "working" } })]);
    await drain();
    statusEvent(h.watcher, "t1", { state: "done", msg: "Already finished." });
    await drain();
    const record = await h.store.create({
      text: "A late record",
      terminal: "t1",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    await drain();
    await h.clock.advance(500);
    await h.clock.advance(300);

    expect(h.store.snapshot().tasks[record.id]?.outcome).toMatchObject({
      state: "done",
      summary: "Already finished.",
    });
  });

  test("links unlinked program tasks on created events and snapshots without double-linking", async () => {
    const first = taskRecord(id("e"), { terminal: undefined });
    const second = taskRecord(id("f"), { terminal: undefined });
    const h = await harness([first, second]);
    const phoneClaim = await h.store.link(first.id, "t1");
    snapshot(h.watcher, [terminal("t1"), terminal("t2")]);
    await drain();
    expect(h.store.snapshot().tasks[first.id]?.terminal).toBe("t1");
    expect(h.store.snapshot().tasks[second.id]?.terminal).toBe("t2");
    expect(phoneClaim.terminal).toBe("t1");

    await h.store.create({
      text: "Window task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    const createdTerminal = terminal("t3", { created_ms: h.clock.now() });
    event(h.watcher, "created", "t3", createdTerminal);
    await drain();
    const newRecord = Object.values(h.store.snapshot().tasks).find(
      (candidate) => candidate.terminal === "t3",
    );
    expect(newRecord).toBeDefined();
  });

  test("swallows a task_linked race while matching an unlinked record", async () => {
    const record = taskRecord(id("1"), { terminal: undefined });
    const h = await harness([record]);
    h.store.link = async () => {
      throw new TaskStoreError("task_linked");
    };
    snapshot(h.watcher, [terminal("t1")]);
    await drain();

    expect(h.logger.entries.filter((entry) => entry.level === "error")).toHaveLength(0);
    expect(h.store.snapshot().tasks[record.id]?.terminal).toBeUndefined();
  });

  test("coalesces multiple dirty outcomes into one document write", async () => {
    const first = taskRecord(id("2"), { terminal: "t1" });
    const second = taskRecord(id("3"), { terminal: "t2" });
    const h = await harness([first, second]);
    snapshot(h.watcher, [
      terminal("t1", { status: { state: "done", msg: "First." } }),
      terminal("t2", { status: { state: "working" } }),
    ]);
    await drain();
    await h.clock.advance(100);
    statusEvent(h.watcher, "t2", { state: "done", msg: "Second." });
    event(h.watcher, "turn", "t2", { turn: 2 });
    await drain();
    await h.clock.advance(199);
    expect(h.core.sets).toHaveLength(0);
    await h.clock.advance(1);

    expect(h.core.sets).toHaveLength(1);
    expect(h.store.snapshot().tasks[first.id]?.outcome?.summary).toBe("First.");
    expect(h.store.snapshot().tasks[second.id]?.outcome?.summary).toBe("Second.");
  });

  test("retries document conflicts after five seconds and stops after three retries", async () => {
    const record = taskRecord(id("4"));
    const h = await harness([record]);
    h.core.conflicts = 2;
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "Conflict task." } })]);
    await drain();
    await h.clock.advance(300);
    expect(h.store.snapshot().tasks[record.id]?.outcome).toBeUndefined();
    expect(h.core.sets).toHaveLength(2);
    await h.clock.advance(4_999);
    expect(h.core.sets).toHaveLength(2);
    await h.clock.advance(1);
    expect(h.store.snapshot().tasks[record.id]?.outcome?.summary).toBe("Conflict task.");
    expect(h.core.sets).toHaveLength(4);

    const stuck = await harness([taskRecord(id("5"))]);
    stuck.core.conflicts = 20;
    snapshot(stuck.watcher, [terminal("t1", { status: { state: "done", msg: "Repeated." } })]);
    await drain();
    await stuck.clock.advance(300);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await stuck.clock.advance(5_000);
    }
    const attemptsAfterCap = stuck.core.sets.length;
    await stuck.clock.advance(15_000);
    expect(stuck.core.sets).toHaveLength(attemptsAfterCap);
    expect(stuck.watcher.status().pendingWrites).toBe(1);
  });

  test("logs tasks_full without task content and drops the pending flush", async () => {
    const records: TaskRecord[] = [];
    for (let index = 0; index < 150; index += 1) {
      records.push(
        taskRecord(`tk${index.toString(16).padStart(32, "0")}`, {
          terminal: undefined,
          text: "x".repeat(7_900),
        }),
      );
    }
    const target = taskRecord(id("6"), { text: "PRIVATE TASK TEXT" });
    records.push(target);
    const h = await harness(records);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "Private summary" } })]);
    await drain();
    await h.clock.advance(300);

    expect(h.watcher.status().pendingWrites).toBe(0);
    expect(h.store.snapshot().tasks[target.id]?.outcome).toBeUndefined();
    expect(h.logger.entries.some((entry) => entry.fields?.code === "tasks_full")).toBe(true);
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE TASK TEXT");
    expect(JSON.stringify(h.logger.entries)).not.toContain("Private summary");
  });

  test("emits transitions once per class and turn, including recordless agents, without text logs", async () => {
    const record = taskRecord(id("7"));
    const stopped = taskRecord(id("8"), { terminal: "t-stopped" });
    const h = await harness([record, stopped]);
    snapshot(h.watcher, [
      terminal("t1", { status: { state: "blocked", msg: "Secret question" } }),
      terminal("t-stopped", { status: { state: "working" } }),
    ]);
    await drain();
    expect(h.transitions).toHaveLength(0);
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Secret question" });
    statusEvent(h.watcher, "t1", { state: "blocked", msg: "Secret question" });
    statusEvent(h.watcher, "t1", { state: "done", msg: "Secret summary" });
    statusEvent(h.watcher, "t1", { state: "done", msg: "Secret summary" });
    event(h.watcher, "turn", "t1", { turn: 2 });
    statusEvent(h.watcher, "t1", { state: "done", msg: "Turn two." });
    event(h.watcher, "removed", "t-stopped", {});
    const outside = terminal("t-outside", {
      status: { state: "blocked", msg: "Outside question" },
    });
    event(h.watcher, "created", "t-outside", outside);
    await drain();

    expect(h.transitions.map((transition) => [transition.address, transition.kind])).toEqual([
      ["t1", "done"],
      ["t1", "done"],
      ["t-stopped", "stopped"],
      ["t-outside", "needs-you"],
    ]);
    expect(h.transitions[0]?.summary).toBe("Secret summary");
    expect(h.transitions.find((transition) => transition.address === "t-outside")?.question).toBe(
      "Outside question",
    );
    expect(JSON.stringify(h.logger.entries)).not.toContain("Secret question");
    expect(JSON.stringify(h.logger.entries)).not.toContain("Secret summary");
    expect(JSON.stringify(h.logger.entries)).not.toContain("PRIVATE TASK TEXT");
  });

  test("ignores remote terminals and reports liveness, counts, and resume forwarding", async () => {
    const local = taskRecord(id("8"), { terminal: "t-live" });
    const remote = taskRecord(id("9"), { terminal: "box/t1" });
    const h = await harness([local, remote]);
    snapshot(h.watcher, [
      terminal("t-live"),
      terminal("t-kept", { reason: "exited" }),
      terminal("box/t1", { address: "box/t1", status: { state: "done", msg: "remote" } }),
    ]);
    await drain();

    expect([...(h.watcher.liveTerminals() ?? [])]).toEqual(["t-live"]);
    expect(h.watcher.status()).toMatchObject({ terminals: 3, tracked: 1, state: "live", seq: 1 });
    expect(h.transitions).toHaveLength(0);
    h.watcher.resume();
    expect(h.connection.resumes).toBe(1);
    h.connection.state = { ...h.connection.state, state: "backoff" };
    expect(h.watcher.liveTerminals()).toBeUndefined();
  });

  test("stops the connection and cancels its pending writes", async () => {
    const record = taskRecord(id("a"));
    const h = await harness([record]);
    snapshot(h.watcher, [terminal("t1", { status: { state: "done", msg: "Soon." } })]);
    await drain();
    expect(h.watcher.status().pendingWrites).toBe(1);

    await h.watcher.stop();
    await h.clock.advance(1_000);

    expect(h.connection.stops).toBe(1);
    expect(h.core.sets).toHaveLength(0);
    expect(h.watcher.status().pendingWrites).toBe(0);
  });
});
