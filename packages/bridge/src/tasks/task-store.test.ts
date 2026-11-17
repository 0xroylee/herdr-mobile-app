import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type {
  DeviceRecordView,
  TaskOutcome,
  TaskRecord,
  TasksDocument,
} from "@herdr-mobile/protocol";
import { TASKS_DOC_NAME, TASKS_MAX_AGE_MS, TASKS_TARGET_BYTES } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { TaskCoreCaller } from "./task-store.ts";
import { TaskStore, TaskStoreError } from "./task-store.ts";

class FakeClock implements Clock {
  time = 1_000_000;
  now(): number {
    return this.time;
  }
  setTimeout(): unknown {
    throw new Error("TaskStore does not schedule timers");
  }
  clearTimeout(): void {}
}

class FakeCore {
  document: TasksDocument = { v: 1, tasks: {} };
  version = 0;
  live: Array<string | { address: string; state: string; reason?: unknown }> = [];
  docValue: unknown = undefined;
  externalDocument: TasksDocument | undefined;
  readonly calls: string[] = [];
  gets = 0;
  lists = 0;
  sets: Array<{ version: number; value: TasksDocument }> = [];
  conflicts = 0;
  getFailure: Error | undefined;
  setFailure: Error | undefined;

  readonly call: TaskCoreCaller = async (method, params) => {
    this.calls.push(method);
    if (method === "doc.get") {
      this.gets += 1;
      expect(params).toEqual({ name: TASKS_DOC_NAME });
      if (this.getFailure) throw this.getFailure;
      return {
        value: structuredClone(this.docValue === undefined ? this.document : this.docValue),
        version: this.version,
      };
    }
    if (method === "terminal.list") {
      this.lists += 1;
      return {
        terminals: this.live.map((terminal) =>
          typeof terminal === "string" ? { address: terminal, state: "live" } : terminal,
        ),
      };
    }
    if (method !== "doc.set") throw new Error(`unexpected method ${method}`);
    const input = params as { name: string; version: number; value: TasksDocument };
    expect(input.name).toBe(TASKS_DOC_NAME);
    this.sets.push({ version: input.version, value: structuredClone(input.value) });
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      if (this.externalDocument !== undefined) {
        this.document = structuredClone(this.externalDocument);
        this.externalDocument = undefined;
      }
      this.version += 1;
      throw new HcRpcError({
        code: -32000,
        message: "document version conflict",
        data: { kind: "conflict" },
      });
    }
    if (this.setFailure) throw this.setFailure;
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

const control: DeviceRecordView = {
  id: "device-1",
  name: "Phone",
  role: "control",
  createdAt: 1,
  lastSeenAt: null,
};

function record(id: string, changes: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    origin: "herdr",
    createdAt: 1,
    ...changes,
  };
}

async function opened(core = new FakeCore(), clock = new FakeClock()) {
  return { core, clock, store: await TaskStore.open(core.call, clock) };
}

describe("TaskStore", () => {
  test("creates without contacting an unavailable core", async () => {
    let calls = 0;
    const store = TaskStore.create(async () => {
      calls += 1;
      throw new Error("core is down");
    });

    expect(calls).toBe(0);
    expect(store.snapshot()).toEqual({ v: 1, tasks: {} });
    await expect(
      store.create({
        text: "Review this change",
        run: { kind: "program", id: "claude" },
        folder: "/repo",
      }),
    ).rejects.toMatchObject({ code: "core_unavailable" });
    expect(calls).toBe(1);
  });

  test("loads the document on its first write before setting it", async () => {
    const core = new FakeCore();
    const store = TaskStore.create(core.call, new FakeClock());

    expect(core.calls).toEqual([]);
    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });

    expect(core.calls[0]).toBe("doc.get");
    expect(core.calls.at(-1)).toBe("doc.set");
    expect(core.gets).toBe(1);
    expect(core.document.tasks[created.id]).toEqual(created);
  });

  test("records several outcomes in one write and leaves other fields intact", async () => {
    const { core, store } = await opened();
    const first = await store.create({
      text: "First task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    const second = await store.create({
      text: "Second task",
      run: { kind: "program", id: "codex" },
      folder: "/repo",
    });
    const firstOutcome: TaskOutcome = { state: "done", turn: 2, ended: true, at: 3 };
    const secondOutcome: TaskOutcome = { state: "stopped", turn: 1, ended: true, at: 4 };
    core.sets.length = 0;

    await store.recordOutcomes({
      [first.id]: firstOutcome,
      [second.id]: secondOutcome,
      [`tk${"f".repeat(32)}`]: firstOutcome,
    });

    expect(core.sets).toHaveLength(1);
    expect(store.snapshot().tasks[first.id]).toMatchObject({
      text: "First task",
      folder: "/repo",
      outcome: firstOutcome,
    });
    expect(store.snapshot().tasks[second.id]?.outcome).toEqual(secondOutcome);
    await store.recordOutcomes({ [first.id]: undefined });
    expect(store.snapshot().tasks[first.id]).not.toHaveProperty("outcome");
    expect(store.snapshot().tasks[second.id]?.outcome).toEqual(secondOutcome);
  });

  test("uses provided live terminals and falls back when the provider returns undefined", async () => {
    const supplied = new FakeCore();
    const suppliedStore = TaskStore.create(supplied.call, new FakeClock(), {
      liveTerminals: () => new Set(),
    });
    await suppliedStore.create({
      text: "Task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(supplied.lists).toBe(0);

    const fallback = new FakeCore();
    const fallbackStore = TaskStore.create(fallback.call, new FakeClock(), {
      liveTerminals: () => undefined,
    });
    await fallbackStore.create({
      text: "Task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(fallback.lists).toBe(1);
  });

  test("notifies after confirmed writes and after a conflict reread", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call, new FakeClock());
    const snapshots: TasksDocument[] = [];
    store.onChange(() => snapshots.push(store.snapshot()));
    const externalId = `tk${"b".repeat(32)}`;
    core.conflicts = 1;
    core.externalDocument = {
      v: 1,
      tasks: { [externalId]: record(externalId, { text: "External task" }) },
    };

    const created = await store.create({
      text: "Local task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.tasks[externalId]?.text).toBe("External task");
    expect(snapshots[0]?.tasks[created.id]).toBeUndefined();
    expect(snapshots[1]?.tasks[externalId]?.text).toBe("External task");
    expect(snapshots[1]?.tasks[created.id]).toEqual(created);
  });

  test("refreshes a changed document and notifies after replacing its memory", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call, new FakeClock());
    const externalId = `tk${"c".repeat(32)}`;
    const snapshots: TasksDocument[] = [];
    store.onChange(() => snapshots.push(store.snapshot()));
    core.version = 4;
    core.document = {
      v: 1,
      tasks: { [externalId]: record(externalId, { text: "External task" }) },
    };

    await store.refresh();

    expect(core.calls.at(-1)).toBe("doc.get");
    expect(store.snapshot().tasks[externalId]?.text).toBe("External task");
    expect(snapshots).toEqual([store.snapshot()]);

    await store.create({
      text: "Local task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(core.sets.at(-1)?.version).toBe(4);
  });

  test("refreshes a new version without notifying when task data is unchanged", async () => {
    const { core, store } = await opened();
    const changes: TasksDocument[] = [];
    store.onChange(() => changes.push(store.snapshot()));
    core.version = 9;

    await store.refresh();

    expect(changes).toEqual([]);
    await store.create({
      text: "Uses refreshed version",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(core.sets.at(-1)?.version).toBe(9);
  });

  test("leaves memory and version unchanged when refresh fails", async () => {
    const { core, store } = await opened();
    const before = store.snapshot();
    core.getFailure = new Error("read failed");

    await expect(store.refresh()).rejects.toMatchObject({ code: "core_unavailable" });

    expect(store.snapshot()).toEqual(before);
    core.getFailure = undefined;
    await store.create({
      text: "Uses original version",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(core.sets.at(-1)?.version).toBe(0);
  });

  test("opens the core document and returns isolated snapshots", async () => {
    const core = new FakeCore();
    const id = `tk${"a".repeat(32)}`;
    core.version = 7;
    core.document = { v: 1, tasks: { [id]: record(id, { text: "A task" }) } };
    const store = await TaskStore.open(core.call);
    const snapshot = store.snapshot();
    const snapshotRecord = snapshot.tasks[id];
    if (!snapshotRecord) throw new Error("opened snapshot is missing its task");
    snapshotRecord.text = "changed outside";

    expect(core.gets).toBe(1);
    expect(store.snapshot().tasks[id]?.text).toBe("A task");
  });

  test.each([
    ["missing", null],
    ["unparsable", { v: 2, tasks: {} }],
  ])("opens an empty document when the core value is %s", async (_name, value) => {
    const core = new FakeCore();
    core.version = 7;
    core.docValue = value;
    const store = await TaskStore.open(core.call);

    expect(store.snapshot()).toEqual({ v: 1, tasks: {} });
    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    expect(core.sets[0]?.version).toBe(7);
    expect(core.document.tasks[created.id]).toEqual(created);
  });

  test("creates a phone record after the caller asks, with a cryptographic task id", async () => {
    const { core, store } = await opened();
    const created = await store.create({
      text: "Review the new route",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { id: "sp1" },
      tab: { id: "tb1" },
      placement: "core",
      terminal: "t1",
      createdBy: control,
    });

    expect(created.id).toMatch(/^tk[0-9a-f]{32}$/u);
    expect(created).toMatchObject({
      origin: "phone",
      terminal: "t1",
      text: "Review the new route",
      createdAt: 1_000_000,
      createdBy: { deviceId: "device-1", deviceName: "Phone" },
      placement: "core",
    });
    expect(core.sets).toHaveLength(1);
    expect(core.document.tasks[created.id]).toEqual(created);
  });

  test("links an unlinked task once and preserves terminal uniqueness", async () => {
    const { store } = await opened();
    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "codex" },
      folder: "/repo",
    });
    await expect(store.link(created.id, "t1")).resolves.toMatchObject({ terminal: "t1" });
    await expect(store.link(created.id, "t1")).rejects.toMatchObject({ code: "task_linked" });

    const second = await store.create({
      text: "Investigate another issue",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    await expect(store.link(second.id, "t1")).rejects.toMatchObject({ code: "task_linked" });
  });

  test("checks and unchecks a record with its turn and checking device", async () => {
    const { store } = await opened();
    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    await expect(store.check(created.id, 3, control)).resolves.toMatchObject({
      checkedTurn: 3,
      checkedAt: 1_000_000,
      checkedBy: { deviceId: "device-1", deviceName: "Phone" },
    });
    const unchecked = await store.uncheck(created.id);
    expect(unchecked.id).toBe(created.id);
    expect(unchecked).not.toHaveProperty("checkedTurn");
    expect(unchecked).not.toHaveProperty("checkedAt");
    expect(unchecked).not.toHaveProperty("checkedBy");
  });

  test("rejects prototype task ids and terminal addresses without mutating shared prototypes", async () => {
    const { core, store } = await opened();
    const unchecked = await store.create({
      text: "Keep this unchecked record",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });
    const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    const setCount = core.sets.length;

    for (const key of ["__proto__", "constructor", "prototype"]) {
      await expect(store.check(key, 0, control)).rejects.toMatchObject({
        code: "task_not_found",
      });
      await expect(store.link(key, "t1")).rejects.toMatchObject({ code: "task_not_found" });
      await expect(store.uncheck(key)).rejects.toMatchObject({ code: "task_not_found" });
      await expect(store.check({ terminal: key }, 0, control)).rejects.toMatchObject({
        code: "task_not_found",
      });
      await expect(store.link(unchecked.id, key)).rejects.toMatchObject({
        code: "task_not_found",
      });
    }

    expect(core.sets).toHaveLength(setCount);
    expect(store.snapshot().tasks[unchecked.id]).toEqual(unchecked);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(descriptors);
  });

  test("checking a from-Herdr terminal creates and checks a Herdr-origin record", async () => {
    const { store } = await opened();
    const checked = await store.check({ terminal: "t-mac" }, 2, control);

    expect(checked.id).toMatch(/^tk[0-9a-f]{32}$/u);
    expect(checked).toMatchObject({
      origin: "herdr",
      terminal: "t-mac",
      checkedTurn: 2,
      checkedBy: { deviceId: "device-1", deviceName: "Phone" },
    });
    expect(store.snapshot().tasks[checked.id]).toEqual(checked);
  });

  test("clears only checked-off records whose terminals ended or are missing", async () => {
    const { core } = await opened();
    const checkedLive = `tk${"1".repeat(32)}`;
    const checkedEnded = `tk${"2".repeat(32)}`;
    const unchecked = `tk${"3".repeat(32)}`;
    const otherSpace = `tk${"4".repeat(32)}`;
    core.live = ["t-live"];
    core.document = {
      v: 1,
      tasks: {
        [checkedLive]: record(checkedLive, { terminal: "t-live", checkedTurn: 0, checkedAt: 5 }),
        [checkedEnded]: record(checkedEnded, {
          terminal: "t-ended",
          checkedTurn: 0,
          checkedAt: 5,
          space: { id: "sp1" },
        }),
        [unchecked]: record(unchecked, { terminal: "t-missing", space: { id: "sp1" } }),
        [otherSpace]: record(otherSpace, {
          terminal: "t-old",
          checkedTurn: 0,
          checkedAt: 5,
          space: { id: "sp2" },
        }),
      },
    };
    const refreshed = await TaskStore.open(core.call, new FakeClock());
    const removed = await refreshed.clear("sp1", new Set(["t-live"]));

    expect(removed).toEqual([checkedEnded]);
    expect(refreshed.snapshot().tasks).toHaveProperty(checkedLive);
    expect(refreshed.snapshot().tasks).toHaveProperty(unchecked);
    expect(refreshed.snapshot().tasks).toHaveProperty(otherSpace);
  });

  test("re-reads and retries one conflicting write against the confirmed version", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call);
    core.conflicts = 1;
    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });

    expect(core.gets).toBe(2);
    expect(core.sets.map((set) => set.version)).toEqual([0, 1]);
    expect(core.document.tasks[created.id]).toEqual(created);
  });

  test("serializes simultaneous writes and keeps both records", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call);
    const [first, second] = await Promise.all([
      store.create({
        text: "First concurrent task",
        run: { kind: "program", id: "claude" },
        folder: "/repo",
      }),
      store.create({
        text: "Second concurrent task",
        run: { kind: "program", id: "codex" },
        folder: "/repo",
      }),
    ]);

    expect(core.sets.map((set) => set.version)).toEqual([0, 1]);
    expect(core.document.tasks[first.id]).toEqual(first);
    expect(core.document.tasks[second.id]).toEqual(second);
  });

  test("preserves another writer's record when retrying a version conflict", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call);
    const externalId = `tk${"e".repeat(32)}`;
    core.conflicts = 1;
    core.externalDocument = {
      v: 1,
      tasks: { [externalId]: record(externalId, { text: "Other phone task" }) },
    };

    const created = await store.create({
      text: "Review this change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
    });

    expect(core.gets).toBe(2);
    expect(core.document.tasks[externalId]?.text).toBe("Other phone task");
    expect(core.document.tasks[created.id]).toEqual(created);
    expect(core.sets[1]?.value.tasks[externalId]?.text).toBe("Other phone task");
  });

  test("returns conflict after one retry and keeps the last confirmed document in memory", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call);
    core.conflicts = 2;

    await expect(
      store.create({
        text: "Review this change",
        run: { kind: "program", id: "claude" },
        folder: "/repo",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(store.snapshot()).toEqual(core.document);
    expect(core.gets).toBe(2);
    expect(core.sets).toHaveLength(2);
  });

  test("prunes old and ended checked records in newest-first order", async () => {
    const core = new FakeCore();
    const clock = new FakeClock();
    const tasks: Record<string, TaskRecord> = {};
    for (let index = 0; index < 205; index += 1) {
      const id = `tk${index.toString(16).padStart(32, "0")}`;
      tasks[id] = record(id, {
        terminal: `t${index}`,
        checkedTurn: 1,
        checkedAt: index + 1,
      });
    }
    core.document = { v: 1, tasks };
    const store = await TaskStore.open(core.call, clock);
    await store.check({ terminal: "t-new" }, 0, control);

    expect(Object.keys(store.snapshot().tasks)).toHaveLength(200);
    expect(store.snapshot().tasks[`tk${"0".repeat(32)}`]).toBeUndefined();
    expect(store.snapshot().tasks[`tk${"0".repeat(30)}06`]).toBeDefined();
    expect(store.snapshot().tasks[`tk${"0".repeat(30)}cc`]).toBeDefined();
  });

  test("prunes a checked live terminal with a lost program but keeps a running agent", async () => {
    const core = new FakeCore();
    const clock = new FakeClock();
    const tasks: Record<string, TaskRecord> = {};
    const lostId = `tk${"0".repeat(32)}`;
    tasks[lostId] = record(lostId, {
      terminal: "t-lost",
      checkedTurn: 1,
      checkedAt: 1,
    });
    for (let index = 1; index <= 200; index += 1) {
      const id = `tk${index.toString(16).padStart(32, "0")}`;
      tasks[id] = record(id, {
        terminal: `t-${index}`,
        checkedTurn: 1,
        checkedAt: index + 1,
      });
    }
    const runningId = `tk${"f".repeat(32)}`;
    tasks[runningId] = record(runningId, {
      terminal: "t-running",
      checkedTurn: 1,
      checkedAt: 1,
    });
    core.document = { v: 1, tasks };
    core.live = [
      { address: "t-lost", state: "live", reason: "signaled" },
      { address: "t-running", state: "live", reason: null },
    ];
    const store = await TaskStore.open(core.call, clock);

    await store.check({ terminal: "t-new" }, 1, control);

    expect(store.snapshot().tasks[lostId]).toBeUndefined();
    expect(store.snapshot().tasks[runningId]).toBeDefined();
  });

  test("prunes checked records toward the 768 KiB target", async () => {
    const core = new FakeCore();
    const tasks: Record<string, TaskRecord> = {};
    for (let index = 0; index < 100; index += 1) {
      const id = `tk${index.toString(16).padStart(32, "0")}`;
      tasks[id] = record(id, {
        text: "x".repeat(8 * 1024),
        checkedTurn: 1,
        checkedAt: index + 1,
      });
    }
    core.document = { v: 1, tasks };
    const store = await TaskStore.open(core.call);

    await store.check({ terminal: "t-new" }, 1, control);

    const bytes = new TextEncoder().encode(JSON.stringify(store.snapshot())).byteLength;
    expect(bytes).toBeLessThanOrEqual(TASKS_TARGET_BYTES);
    expect(Object.keys(store.snapshot().tasks).length).toBeLessThan(101);
  });

  test("prunes checked records older than 30 days even when their terminal is live", async () => {
    const core = new FakeCore();
    const clock = new FakeClock();
    const expired = `tk${"a".repeat(32)}`;
    const recent = `tk${"b".repeat(32)}`;
    core.live = ["t-live"];
    core.document = {
      v: 1,
      tasks: {
        [expired]: record(expired, {
          terminal: "t-live",
          checkedTurn: 0,
          checkedAt: clock.time - TASKS_MAX_AGE_MS - 1,
        }),
        [recent]: record(recent, {
          terminal: "t-live",
          checkedTurn: 0,
          checkedAt: clock.time - 1,
        }),
      },
    };
    const store = await TaskStore.open(core.call, clock);

    await store.uncheck(recent);

    expect(store.snapshot().tasks[expired]).toBeUndefined();
    expect(store.snapshot().tasks[recent]).toBeDefined();
    expect(store.snapshot().tasks[recent]).not.toHaveProperty("checkedTurn");
  });

  test("returns tasks_full without dropping unchecked records or changing memory", async () => {
    const core = new FakeCore();
    const tasks: Record<string, TaskRecord> = {};
    for (let index = 0; index < 150; index += 1) {
      const id = `tk${index.toString(16).padStart(32, "0")}`;
      tasks[id] = record(id, { text: "x".repeat(7_000) });
    }
    core.document = { v: 1, tasks };
    const store = await TaskStore.open(core.call);
    const before = store.snapshot();

    await expect(
      store.create({
        text: "Add one more task",
        run: { kind: "program", id: "claude" },
        folder: "/repo",
      }),
    ).rejects.toMatchObject({ code: "tasks_full" });
    expect(core.sets).toHaveLength(0);
    expect(store.snapshot()).toEqual(before);
  });

  test("keeps memory at the last confirmed document after a failed write", async () => {
    const core = new FakeCore();
    const store = await TaskStore.open(core.call);
    core.setFailure = new Error("write failed");

    await expect(
      store.create({
        text: "Review this change",
        run: { kind: "program", id: "claude" },
        folder: "/repo",
      }),
    ).rejects.toMatchObject({ code: "core_unavailable" });
    expect(store.snapshot()).toEqual({ v: 1, tasks: {} });
  });

  test("returns task_not_found and rejects invalid turns", async () => {
    const { store } = await opened();
    await expect(store.check("missing", 0, control)).rejects.toBeInstanceOf(TaskStoreError);
    await expect(store.uncheck("missing")).rejects.toMatchObject({ code: "task_not_found" });
    await expect(store.check({ terminal: "t1" }, -1, control)).rejects.toMatchObject({
      code: "task_not_found",
    });
  });
});
