/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { HcEvent, Status, TaskOutcome, TaskRecord, Terminal } from "@herdr-mobile/protocol";
import {
  classOf,
  desiredOutcome,
  type Mark,
  mark,
  readAllowed,
  reduce,
  sameOutcome,
  type Tracked,
} from "./task-knowledge.ts";
import { ModelCore } from "./testing/model-core.ts";

function terminal(overrides: Partial<Terminal> = {}): Terminal {
  return {
    address: "t1",
    argv: ["agent"],
    cols: 80,
    created_ms: 1,
    cwd: "/work",
    labels: {},
    rows: 24,
    screen: "",
    state: "live",
    turn: 0,
    ...overrides,
  };
}

function record(outcome?: TaskOutcome, terminalAddress = "t1"): TaskRecord {
  return {
    id: "tk00000000000000000000000000000001",
    origin: "phone",
    terminal: terminalAddress,
    createdAt: 1,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function tracked(overrides: Partial<Tracked> = {}): Tracked {
  return { address: "t1", present: true, ...overrides };
}

function statusEvent(status: Status | null, address = "t1"): HcEvent {
  return {
    seq: 1,
    type: "status",
    terminal: address,
    data: { status: status === null ? null : { ...status }, records: {}, reported: true },
  };
}

function desired(trackedTask: Tracked, now = 5_000): TaskOutcome | undefined {
  return desiredOutcome(trackedTask, now).outcome;
}

describe("classOf", () => {
  const cases: Array<{ name: string; value: Tracked; expected?: Mark }> = [
    { name: "not eligible", value: tracked() },
    {
      name: "live done status",
      value: tracked({ view: terminal({ status: { state: "done" }, reported: true }) }),
      expected: { kind: "done", turn: 0 },
    },
    {
      name: "live idle after work",
      value: tracked({ view: terminal({ status: { state: "idle" }, turn: 1, reported: true }) }),
      expected: { kind: "done", turn: 1 },
    },
    {
      name: "live blocked",
      value: tracked({ view: terminal({ status: { state: "blocked" }, turn: 2, reported: true }) }),
      expected: { kind: "needs-you", turn: 2 },
    },
    {
      name: "live error",
      value: tracked({ view: terminal({ status: { state: "error" }, turn: 1, reported: true }) }),
      expected: { kind: "needs-you", turn: 1 },
    },
    {
      name: "live working",
      value: tracked({ view: terminal({ status: { state: "working" }, reported: true }) }),
    },
    {
      name: "live idle at turn zero",
      value: tracked({ view: terminal({ status: { state: "idle" }, reported: true }) }),
    },
    {
      name: "live reported without a status",
      value: tracked({ view: terminal({ reported: true }) }),
    },
    {
      name: "ended with last done status",
      value: tracked({
        view: terminal({ state: "finished", turn: 3, status: null }),
        present: true,
        lastStatus: { turn: 2, status: { state: "done" } },
      }),
      expected: { kind: "done", turn: 2 },
    },
    {
      name: "ended successfully after a turn",
      value: tracked({
        view: terminal({ state: "finished", turn: 1, exit_code: 0, reported: true }),
      }),
      expected: { kind: "done", turn: 1 },
    },
    {
      name: "never seen with persisted done",
      value: tracked({
        present: false,
        record: record({ state: "done", turn: 4, ended: true, at: 10 }),
      }),
      expected: { kind: "done", turn: 4 },
    },
    {
      name: "ended with matching persisted done",
      value: tracked({
        view: terminal({ state: "finished", turn: 4, reported: true }),
        lastStatus: undefined,
        record: record({ state: "done", turn: 4, ended: true, at: 10 }),
      }),
      expected: { kind: "done", turn: 4 },
    },
    {
      name: "ended with a stale persisted done",
      value: tracked({
        view: terminal({ state: "finished", turn: 3, reported: true }),
        record: record({ state: "done", turn: 4, ended: true, at: 10 }),
      }),
      expected: { kind: "stopped", turn: 3 },
    },
    {
      name: "ended working status supersedes persisted done",
      value: tracked({
        view: terminal({ state: "finished", turn: 4, reported: true }),
        lastStatus: { turn: 4, status: { state: "working" } },
        record: record({ state: "done", turn: 4, ended: true, at: 10 }),
      }),
      expected: { kind: "stopped", turn: 4 },
    },
    {
      name: "ended idle with nonzero exit is stopped",
      value: tracked({
        view: terminal({ state: "finished", turn: 2, exit_code: 7, status: null }),
        lastStatus: { turn: 2, status: { state: "idle" } },
      }),
      expected: { kind: "stopped", turn: 2 },
    },
    {
      name: "missing with no completion evidence is stopped",
      value: tracked({ present: false, view: terminal({ turn: 1, reported: true }) }),
      expected: { kind: "stopped", turn: 1 },
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const result = classOf(item.value);
      if (item.expected === undefined) expect(result).toBeUndefined();
      else expect(result).toEqual(item.expected);
    });
  }
});

describe("summary selection and outcomes", () => {
  test("uses the same adapter before and after a restating ended snapshot", () => {
    const summarizeHistory = (emitNullStatus: boolean, restate: boolean): string | undefined => {
      const model = new ModelCore();
      const value = tracked({ present: false, record: record() });
      let current = value;
      const steps = [
        {
          now: 0,
          events: model.apply({
            t: 0,
            address: "t1",
            kind: "create",
            argv: ["agent"],
            cwd: "/work",
            labels: {},
            pid: 10,
          }),
        },
        {
          now: 50,
          events: model.apply({
            t: 50,
            address: "t1",
            kind: "report",
            status: { state: "working" },
          }),
        },
        {
          now: 100,
          events: model.apply({
            t: 100,
            address: "t1",
            kind: "report",
            status: { state: "done", app: "codex" },
          }),
        },
        {
          now: 200,
          events: model.apply(
            { t: 200, address: "t1", kind: "exit", code: 7, signal: null, keep: false },
            emitNullStatus,
          ),
        },
      ];

      for (const step of steps) {
        for (const { event, revealed } of step.events) {
          if ((event.type === "created" || event.type === "restarted") && revealed !== undefined) {
            current = reduce(current, { type: "seen", terminal: revealed, now: step.now });
          } else {
            current = reduce(current, { type: "event", event, now: step.now });
          }
        }
      }

      if (restate) {
        const ended = model.snapshot()[0];
        if (ended !== undefined)
          current = reduce(current, { type: "seen", terminal: ended, now: 300 });
      }
      current = reduce(current, { type: "summary-due", now: 850, token: 1 });
      current = reduce(current, {
        type: "summary-read",
        now: 900,
        token: 1,
        rows: ["• Finished correctly"],
      });
      return desired(current)?.summary;
    };

    expect([
      summarizeHistory(false, false),
      summarizeHistory(false, true),
      summarizeHistory(true, false),
      summarizeHistory(true, true),
    ]).toEqual([
      "Finished correctly",
      "Finished correctly",
      "Finished correctly",
      "Finished correctly",
    ]);
  });

  test("a status message takes precedence over a persisted summary", () => {
    const initial = tracked({
      view: terminal({ status: { state: "done", msg: "  finished\ncleanly " }, reported: true }),
      lastStatus: { turn: 0, status: { state: "done", msg: "  finished\ncleanly " } },
      record: record({ state: "done", turn: 0, ended: false, at: 10, summary: "saved" }),
    });
    const result = desiredOutcome(initial, 99);
    expect(result.pending).toBe(false);
    expect(result.outcome?.summary).toBe("finished cleanly");
    expect(initial.summary).toBeUndefined();
  });

  test("a matching summary job is pending before a persisted Done", () => {
    const value = tracked({
      view: terminal({ status: { state: "done" }, reported: true }),
      record: record({ state: "done", turn: 0, ended: false, at: 10, summary: "saved" }),
      summary: { turn: 0, deadline: 3_000, attempts: 0, phase: "waiting", dueAt: 750 },
    });
    expect(desiredOutcome(value, 99)).toEqual({ pending: true });
  });

  test("a settled job takes precedence over a persisted summary", () => {
    const value = tracked({
      view: terminal({ status: { state: "done" }, reported: true }),
      record: record({ state: "done", turn: 0, ended: false, at: 10, summary: "saved" }),
      summary: { turn: 0, deadline: 3_000, attempts: 0, phase: "settled", result: "read" },
    });
    expect(desired(value)?.summary).toBe("read");
  });

  test("a persisted Done supplies its summary and avoids a read", () => {
    const value = tracked({
      view: terminal({ status: { state: "done" }, reported: true }),
      record: record({ state: "done", turn: 0, ended: false, at: 10, summary: "saved" }),
    });
    expect(desiredOutcome(value, 99)).toEqual({
      pending: false,
      outcome: { state: "done", turn: 0, ended: false, at: 99, summary: "saved" },
    });
    expect(value.summary).toBeUndefined();
  });

  test("a matching persisted Done with no summary is settled and does not read", () => {
    const value = tracked({
      view: terminal({ status: { state: "done" }, reported: true }),
      record: record({ state: "done", turn: 0, ended: false, at: 10 }),
    });
    expect(desiredOutcome(value, 99)).toEqual({
      pending: false,
      outcome: { state: "done", turn: 0, ended: false, at: 99 },
    });
  });

  test("sameOutcome ignores only the bridge timestamp", () => {
    const first: TaskOutcome = {
      state: "stopped",
      turn: 2,
      ended: true,
      at: 100,
      exit: { code: 7, signal: null, reason: "exited" },
    };
    expect(sameOutcome(first, { ...first, at: 500 })).toBe(true);
    const exit = first.exit ?? { code: null, signal: null, reason: null };
    expect(sameOutcome(first, { ...first, exit: { ...exit, code: 0 } })).toBe(false);
    expect(sameOutcome(undefined, undefined)).toBe(true);
  });

  test("stopped outcomes include exit facts when the terminal supplied them", () => {
    const value = tracked({
      view: terminal({ state: "finished", turn: 2, reason: "exited", exit_code: 7, signal: null }),
      lastStatus: { turn: 2, status: { state: "working" } },
      record: record(),
    });
    expect(desired(value, 123)).toEqual({
      state: "stopped",
      turn: 2,
      ended: true,
      at: 123,
      exit: { code: 7, signal: null, reason: "exited" },
    });
  });

  test("stopped outcomes omit exit facts when the terminal was only missing", () => {
    const value = tracked({ present: false, record: record() });
    expect(desired(value, 123)).toEqual({ state: "stopped", turn: 0, ended: true, at: 123 });
  });

  test("never-seen missing records preserve a persisted outcome", () => {
    const persisted: TaskOutcome = {
      state: "done",
      turn: 3,
      ended: false,
      at: 10,
      summary: "kept",
    };
    const value = tracked({ present: false, record: record(persisted) });
    const result = desiredOutcome(value, 123);
    expect(result.pending).toBe(false);
    expect(sameOutcome(result.outcome, persisted)).toBe(true);
  });

  test("a never-seen missing record without an outcome is stopped", () => {
    expect(desired(tracked({ present: false, record: record() }), 123)).toEqual({
      state: "stopped",
      turn: 0,
      ended: true,
      at: 123,
    });
  });
});

describe("reduce", () => {
  test("repairs a completion status to the next turn and accepts the following turn event", () => {
    let value = tracked({ view: terminal({ status: { state: "working" }, reported: true }) });
    value = reduce(value, { type: "event", event: statusEvent({ state: "done" }), now: 10 });
    expect(value.view?.turn).toBe(1);
    expect(value.lastStatus).toEqual({ turn: 1, status: { state: "done" } });

    const turn: HcEvent = { seq: 2, type: "turn", terminal: "t1", data: { turn: 1 } };
    const next = reduce(value, { type: "event", event: turn, now: 11 });
    expect(next.view?.turn).toBe(1);
    expect(next.lastStatus).toBe(value.lastStatus);
  });

  test("a second completion after new work belongs to the new turn", () => {
    let value = tracked({ view: terminal({ status: { state: "working" }, reported: true }) });
    value = reduce(value, { type: "event", event: statusEvent({ state: "blocked" }), now: 10 });
    expect(value.view?.turn).toBe(1);
    value = reduce(value, { type: "event", event: statusEvent({ state: "working" }), now: 11 });
    value = reduce(value, { type: "event", event: statusEvent({ state: "blocked" }), now: 12 });
    expect(value.view?.turn).toBe(2);
    expect(value.lastStatus).toEqual({ turn: 2, status: { state: "blocked" } });
  });

  test("idle then done at turn one stays at turn one", () => {
    const value = tracked({
      view: terminal({ status: { state: "idle" }, turn: 1, reported: true }),
    });
    const next = reduce(value, { type: "event", event: statusEvent({ state: "done" }), now: 10 });
    expect(next.view?.turn).toBe(1);
    expect(next.lastStatus?.turn).toBe(1);
  });

  test("a changed pid clears last status before the new life is seen", () => {
    const oldLife = tracked({
      view: terminal({ pid: 10, turn: 2, status: { state: "done" }, reported: true }),
      lifePid: 10,
      lastStatus: { turn: 2, status: { state: "done" } },
    });
    const newLife = reduce(oldLife, {
      type: "seen",
      now: 100,
      terminal: terminal({ pid: 20, turn: 0, status: null, reported: false }),
    });
    expect(newLife.lifePid).toBe(20);
    expect(newLife.lastStatus).toBeUndefined();
    expect(classOf(newLife)).toBeUndefined();
  });

  test("a changed pid at the same turn starts a fresh life’s summary job", () => {
    const oldLife = tracked({
      view: terminal({ pid: 10, turn: 1, status: { state: "done" }, reported: true }),
      lifePid: 10,
      lastStatus: { turn: 1, status: { state: "done" } },
      record: record(),
      summary: { turn: 1, deadline: 3_000, attempts: 0, phase: "waiting", dueAt: 750 },
    });
    const newLife = reduce(oldLife, {
      type: "seen",
      now: 100,
      terminal: terminal({ pid: 20, turn: 1, status: { state: "done" }, reported: true }),
    });
    expect(newLife.summary).toEqual({
      turn: 1,
      deadline: 3_100,
      attempts: 0,
      phase: "waiting",
      dueAt: 850,
    });
    expect(newLife.lastStatus?.status).toEqual({ state: "done" });
  });

  test("a snapshot silently absorbs a class and a later same-class event is deduped", () => {
    const value = tracked({ view: terminal({ status: { state: "blocked" }, reported: true }) });
    const absorbed = mark(value, "silent");
    expect(absorbed.transition).toBeUndefined();
    expect(mark(absorbed.tracked, "event").transition).toBeUndefined();
  });

  test("returns a new record without mutating its inputs", () => {
    const initialView = terminal({ status: { state: "working" }, reported: true });
    const initial = tracked({
      view: initialView,
      record: record(),
    });
    const before = structuredClone(initial);
    const frozen = Object.freeze({
      ...initial,
      view: Object.freeze({ ...initialView }) as Terminal,
    });
    const result = reduce(frozen, {
      type: "event",
      event: statusEvent({ state: "done" }),
      now: 10,
    });
    expect(result).not.toBe(frozen);
    expect(initial).toEqual(before);
    expect(frozen as Tracked).toEqual(before);
  });
});

describe("summary job state machine", () => {
  function newJob(): Tracked {
    const initial = tracked({
      view: terminal({ status: { state: "working" }, reported: true }),
      record: record(),
    });
    return reduce(initial, {
      type: "event",
      event: statusEvent({ state: "done" }),
      now: 1_000,
    });
  }

  test("starts after the delay and accepts a due timer before the deadline", () => {
    const waiting = newJob();
    expect(waiting.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 0,
      phase: "waiting",
      dueAt: 1_750,
    });
    const reading = reduce(waiting, { type: "summary-due", now: 1_750, token: 7 });
    expect(reading.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 0,
      phase: "reading",
      token: 7,
    });
  });

  test("a due timer at or after the deadline settles without starting a read", () => {
    const waiting = newJob();
    const settled = reduce(waiting, { type: "summary-due", now: 4_000, token: 7 });
    expect(settled.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 0,
      phase: "settled",
    });

    const later = reduce(waiting, { type: "summary-due", now: 4_001, token: 8 });
    expect(later.summary).toEqual(settled.summary);
  });

  test("a failed read retries once after two seconds and stops at the cap", () => {
    const reading = reduce(newJob(), { type: "summary-due", now: 1_750, token: 7 });
    const retry = reduce(reading, { type: "summary-read", token: 7, now: 1_750 });
    expect(retry.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 1,
      phase: "waiting",
      dueAt: 3_750,
    });
    const secondRead = reduce(retry, { type: "summary-due", now: 3_750, token: 8 });
    const settled = reduce(secondRead, { type: "summary-read", token: 8, now: 3_750 });
    expect(settled.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 1,
      phase: "settled",
    });
  });

  test("a kept shell settles its job immediately and cannot be read", () => {
    const waiting = newJob();
    const lost: HcEvent = {
      seq: 3,
      type: "lost",
      terminal: "t1",
      data: { reason: "exited", exit_code: 1, signal: null },
    };
    const shell = reduce(waiting, { type: "event", event: lost, now: 1_200 });
    expect(shell.view?.state).toBe("live");
    expect(shell.view?.reason).toBe("exited");
    expect(readAllowed(shell)).toBe(false);
    expect(shell.summary?.phase).toBe("settled");
    expect(shell.summary?.result).toBeUndefined();
  });

  test("a class change removes the job", () => {
    const waiting = newJob();
    const running = reduce(waiting, {
      type: "event",
      event: statusEvent({ state: "working" }),
      now: 1_200,
    });
    expect(classOf(running)).toBeUndefined();
    expect(running.summary).toBeUndefined();
  });

  test("removal settles the job without a screen result", () => {
    const removed = reduce(newJob(), {
      type: "event",
      event: { seq: 3, type: "removed", terminal: "t1", data: {} },
      now: 1_200,
    });
    expect(removed.present).toBe(false);
    expect(readAllowed(removed)).toBe(false);
    expect(removed.summary).toEqual({
      turn: 1,
      deadline: 4_000,
      attempts: 0,
      phase: "settled",
    });
    expect(desiredOutcome(removed, 1_200)).toEqual({
      pending: false,
      outcome: { state: "done", turn: 1, ended: true, at: 1_200 },
    });
  });

  test("a matching read result settles with a one-line screen summary", () => {
    const reading = reduce(newJob(), { type: "summary-due", now: 1_750, token: 7 });
    const settled = reduce(reading, {
      type: "summary-read",
      token: 7,
      now: 1_800,
      rows: ["", "  Finished from the screen  "],
    });
    expect(settled.summary?.phase).toBe("settled");
    expect(settled.summary?.result).toBe("Finished from the screen");
    expect(desired(settled)?.summary).toBe("Finished from the screen");
  });

  test("a stale read token has no effect", () => {
    const reading = reduce(newJob(), { type: "summary-due", now: 1_750, token: 7 });
    const stale = reduce(reading, {
      type: "summary-read",
      token: 8,
      now: 1_800,
      rows: ["Ignored"],
    });
    expect(stale.summary).toEqual(reading.summary);
  });

  test("a stale token cannot settle a newer read already in flight", () => {
    const oldRead = reduce(newJob(), { type: "summary-due", now: 1_750, token: 7 });
    const working = reduce(oldRead, {
      type: "event",
      event: statusEvent({ state: "working" }),
      now: 1_800,
    });
    const nextDone = reduce(working, {
      type: "event",
      event: statusEvent({ state: "done" }),
      now: 1_900,
    });
    const newRead = reduce(nextDone, { type: "summary-due", now: 2_650, token: 8 });
    expect(newRead.summary).toMatchObject({ turn: 2, phase: "reading", token: 8 });

    const stale = reduce(newRead, {
      type: "summary-read",
      token: 7,
      now: 2_700,
      rows: ["Old turn result"],
    });
    expect(stale.summary).toEqual(newRead.summary);

    const current = reduce(stale, {
      type: "summary-read",
      token: 8,
      now: 2_800,
      rows: ["Current turn result"],
    });
    expect(current.summary?.result).toBe("Current turn result");
  });
});

describe("R3 M6", () => {
  test("live idle at turn one is Done, while idle at a nonzero exit is Stopped", () => {
    const liveIdle = tracked({
      view: terminal({ status: { state: "idle" }, turn: 1, reported: true }),
      record: record(),
    });
    expect(classOf(liveIdle)).toEqual({ kind: "done", turn: 1 });

    const endedIdle = tracked({
      view: terminal({ state: "finished", status: null, turn: 1, exit_code: 7, reported: true }),
      lastStatus: { turn: 1, status: { state: "idle" } },
      record: record(),
    });
    expect(classOf(endedIdle)).toEqual({ kind: "stopped", turn: 1 });

    const successfulIdle = tracked({
      view: terminal({ state: "finished", status: null, turn: 1, exit_code: 0, reported: true }),
      lastStatus: { turn: 1, status: { state: "idle" } },
      record: record(),
    });
    expect(classOf(successfulIdle)).toEqual({ kind: "done", turn: 1 });
  });
});
