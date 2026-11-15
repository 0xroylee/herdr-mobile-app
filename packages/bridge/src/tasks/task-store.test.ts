import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type { DeviceRecordView, TaskRecord, TasksDocument } from "@herdr-mobile/protocol";
import { TASKS_DOC_NAME, TASKS_MAX_AGE_MS } from "@herdr-mobile/protocol";
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
  live: string[] = [];
  gets = 0;
  sets: Array<{ version: number; value: TasksDocument }> = [];
  conflicts = 0;
  setFailure: Error | undefined;

  readonly call: TaskCoreCaller = async (method, params) => {
    if (method === "doc.get") {
      this.gets += 1;
      expect(params).toEqual({ name: TASKS_DOC_NAME });
      return { value: structuredClone(this.document), version: this.version };
    }
    if (method === "terminal.list") {
      return {
        terminals: this.live.map((address) => ({ address, state: "live" })),
      };
    }
    if (method !== "doc.set") throw new Error(`unexpected method ${method}`);
    const input = params as { name: string; version: number; value: TasksDocument };
    expect(input.name).toBe(TASKS_DOC_NAME);
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
    const removed = await refreshed.clear("sp1", new Set(core.live));

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
