/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { type Prompt, promptKey } from "../../model/prompt.ts";
import { taskRecord, taskTerminal } from "../../model/tasks.fixtures.ts";
import type { TaskRow } from "../../model/tasks.ts";
import { BridgeApiError, createBridgeApi } from "../../net/bridge-api.ts";
import type { TaskActions } from "../../net/task-actions.ts";
import type { TaskIdentity } from "../project/check-off.ts";
import {
  answerableTaskScreenRows,
  canFollowUp,
  followUpNeedsForce,
  latestOutputRefreshKey,
  latestOutputRows,
  MatchedTaskLinkController,
  shouldFocusFollowUp,
  TaskFocusController,
  type TaskMenuActionId,
  TaskScreenController,
  TaskScreenReadGeneration,
  type TaskScreenRuntime,
  type TaskScreenSnapshot,
  taskLinkErrorMessage,
  taskMenuItems,
  taskRowForRoute,
  taskStartedFact,
  taskStateStrip,
  taskTerminalPresentation,
  UNLINKED_TERMINAL_TIMEOUT_MS,
} from "./task-screen-controller.ts";

describe("task screen controller", () => {
  test.each([
    ["running", "Running · 5m", "working", "working"],
    ["needs-you", "Needs you · 5m", "blockedCompact", "blocked"],
    ["done", "Done · 5m", "done", "done"],
    ["stopped", "Stopped · 5m", "stopped", "danger"],
    ["checked", "Checked off · 5m", "checked", "dim"],
    ["not-started", "Not started · 5m", "idle", "dim"],
  ] as const)("describes %s in the state strip", (state, label, mark, tone) => {
    expect(taskStateStrip(state, "5m")).toEqual({ label, mark, tone });
  });

  test("keys output reads by address, turn and status", () => {
    const row = makeRow("running");
    expect(latestOutputRefreshKey(row)).toBe(JSON.stringify(["t-task", 1, { state: "working" }]));
    expect(
      latestOutputRefreshKey({
        ...row,
        terminal: taskTerminal("t-task", { turn: 2, status: { state: "blocked" } }),
      }),
    ).toBe(JSON.stringify(["t-task", 2, { state: "blocked" }]));
    expect(
      latestOutputRefreshKey({
        ...row,
        terminal: taskTerminal("t-task", { status: { state: "working", msg: "Updated" } }),
      }),
    ).not.toBe(latestOutputRefreshKey(row));
    expect(latestOutputRefreshKey(makeRow("running", { address: undefined }))).toBeUndefined();
  });

  test("keeps the last eight non-blank output rows", () => {
    expect(
      latestOutputRows(["", "  ", ...Array.from({ length: 9 }, (_, i) => `line ${i}`)]),
    ).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`));
  });

  test("shows the unlinked wait, timeout and missing-terminal states", () => {
    const unlinked = makeRow("running", { unlinked: true, address: undefined });
    expect(
      taskTerminalPresentation(unlinked, unlinked.createdAt + UNLINKED_TERMINAL_TIMEOUT_MS - 1),
    ).toBe("starting");
    expect(
      taskTerminalPresentation(unlinked, unlinked.createdAt + UNLINKED_TERMINAL_TIMEOUT_MS),
    ).toBe("not-found");
    for (const state of ["stopped", "done", "checked"] as const) {
      expect(taskTerminalPresentation(makeRow(state, { terminal: null }), 50_000)).toBe("missing");
    }
    expect(taskTerminalPresentation(makeRow("running"), 50_000)).toBeUndefined();
  });

  test("only offers prompt rows from the current machine, address and refresh generation", () => {
    const row = makeRow("needs-you");
    const refreshKey = latestOutputRefreshKey(row);
    const output = {
      machineId: "machine-1",
      address: "t-task",
      refreshKey: refreshKey as string,
      generation: 7,
      rows: ["cached menu"],
    };

    expect(answerableTaskScreenRows(row, "machine-1", refreshKey, 7, output)).toEqual([
      "cached menu",
    ]);
    expect(answerableTaskScreenRows(row, "machine-2", refreshKey, 7, output)).toEqual([]);
    expect(answerableTaskScreenRows(row, "machine-1", refreshKey, 8, output)).toEqual([]);
    expect(
      answerableTaskScreenRows({ ...row, address: "t-other" }, "machine-1", refreshKey, 7, output),
    ).toEqual([]);
  });

  test("advances screen generations when a refresh input changes", () => {
    const generation = new TaskScreenReadGeneration();
    const terminal = taskTerminal("t-task");
    const reader = {};
    const version = {
      machineId: "machine-1",
      connected: true,
      refreshKey: "turn-1",
      terminal,
      reader,
    };

    expect(generation.next(version)).toBe(1);
    expect(generation.next(version)).toBe(1);
    expect(generation.next({ ...version, refreshKey: "turn-2" })).toBe(2);
    expect(generation.next({ ...version, connected: false })).toBe(3);
  });

  test("resolves a terminal route to the record that claims its address", () => {
    const recordRow = makeRow("checked", {
      record: taskRecord("record-42", { terminal: "t-task", checkedTurn: 1 }),
      address: "t-task",
    });
    const tasks = { rows: [recordRow], taskFor: () => undefined };

    expect(taskRowForRoute("t:t-task", tasks)).toBe(recordRow);
    expect(taskRowForRoute("record-42", tasks)).toBeUndefined();
  });

  test("enables follow-up only for linked writable tasks and forces Needs you sends", () => {
    for (const state of ["running", "needs-you", "done"] as const) {
      expect(canFollowUp(makeRow(state), "control", "connected")).toBe(true);
    }
    for (const state of ["stopped", "checked", "not-started"] as const) {
      expect(canFollowUp(makeRow(state), "control", "connected")).toBe(false);
    }
    expect(canFollowUp(makeRow("running"), "watch", "connected")).toBe(false);
    expect(canFollowUp(makeRow("running"), "control", "reconnecting")).toBe(false);
    expect(canFollowUp(makeRow("running", { address: undefined }), "control", "connected")).toBe(
      false,
    );
    expect(followUpNeedsForce(makeRow("needs-you"))).toBe(true);
    expect(followUpNeedsForce(makeRow("running"))).toBe(false);
  });

  test("shows menu items for each task state and device role", () => {
    const expected: Record<TaskRow["state"], TaskMenuActionId[]> = {
      running: ["open-terminal", "interrupt", "stop-agent", "check-off", "copy-address"],
      "needs-you": ["open-terminal", "interrupt", "stop-agent", "check-off", "copy-address"],
      done: ["open-terminal", "check-off", "copy-address"],
      stopped: ["open-terminal", "check-off", "copy-address"],
      checked: ["open-terminal", "copy-address"],
      "not-started": ["open-terminal", "copy-address"],
    };

    for (const state of Object.keys(expected) as TaskRow["state"][]) {
      expect(
        taskMenuItems(makeRow(state), "control", "connected", 50_000).map(({ id }) => id),
      ).toEqual(expected[state]);
      expect(
        taskMenuItems(makeRow(state), "watch", "connected", 50_000).map(({ id }) => id),
      ).toEqual(["open-terminal", "copy-address"]);
    }
    expect(taskMenuItems(makeRow("running"), "control", "offline", 50_000)).toEqual([]);
    expect(
      taskMenuItems(makeRow("stopped", { terminal: null }), "control", "connected", 50_000).map(
        ({ id }) => id,
      ),
    ).toEqual(["check-off", "copy-address"]);
  });

  test("offers check-off for an unlinked task only after the timeout", () => {
    const row = makeRow("running", { unlinked: true, address: undefined });
    expect(taskMenuItems(row, "control", "connected", row.createdAt).map(({ id }) => id)).toEqual(
      [],
    );
    expect(
      taskMenuItems(row, "control", "connected", row.createdAt + UNLINKED_TERMINAL_TIMEOUT_MS).map(
        ({ id }) => id,
      ),
    ).toEqual(["check-off"]);
  });

  test("links each matched record once on a connected control device", () => {
    const matchedRecord = taskRecord("matched", { terminal: undefined });
    const row = makeRow("running", {
      matched: true,
      address: "t-matched",
      record: matchedRecord,
    });
    const controller = new MatchedTaskLinkController();

    expect(controller.claim(row, "watch", "connected")).toBeUndefined();
    expect(controller.claim(row, "control", "reconnecting")).toBeUndefined();
    expect(controller.claim(row, "control", "connected")).toEqual({
      id: matchedRecord.id,
      terminal: "t-matched",
    });
    expect(controller.claim(row, "control", "connected")).toBeUndefined();
  });

  test("treats a 409 from /api/tasks/link as a successful matched-task link", async () => {
    const api = createBridgeApi(async (input) => {
      expect(input).toBe("https://mac.test/api/tasks/link");
      return Response.json(
        { error: "task_linked", message: "Task is already linked" },
        { status: 409 },
      );
    });
    const request = { id: taskRecord("already-linked").id, terminal: "t-task" };
    const messages: string[] = [];

    await api.linkTask("https://mac.test", "token", request).catch((error: unknown) => {
      const message = taskLinkErrorMessage(error);
      if (message !== undefined) messages.push(message);
    });

    expect(messages).toEqual([]);
    expect(taskLinkErrorMessage(new BridgeApiError(409, "task_missing", "Task is missing"))).toBe(
      "Task is missing",
    );
    expect(taskLinkErrorMessage(new Error("Offline"))).toBe("Offline");
  });

  test("recognizes only the follow-up focus route parameter", () => {
    expect(shouldFocusFollowUp("followup")).toBe(true);
    expect(shouldFocusFollowUp(["followup", "other"])).toBe(true);
    expect(shouldFocusFollowUp("other")).toBe(false);
    expect(shouldFocusFollowUp(undefined)).toBe(false);
  });

  test("consumes a follow-up focus request once after focus", () => {
    const focus = new TaskFocusController();
    let consumed = 0;

    expect(focus.consume("task-a", () => (consumed += 1))).toBe(true);
    expect(focus.consume("task-a", () => (consumed += 1))).toBe(false);
    expect(focus.consume("task-b", () => (consumed += 1))).toBe(true);
    expect(consumed).toBe(2);
  });

  test("delivers follow-up and typed menu answers through the task action port", async () => {
    const prompt = makePrompt();
    const { controller, calls, runtime, setSnapshot } = makeController(
      makeSnapshot(makeRow("running"), { prompt: undefined, screenGeneration: 3 }),
    );
    const identity = makeIdentity();

    expect(
      await controller.submitComposer(identity, "continue the work", {
        optionsOffered: false,
        promptKey: undefined,
        screenGeneration: 3,
      }),
    ).toEqual({ kind: "sent" });
    expect(calls.filter(({ method }) => method === "followUp")).toEqual([
      { method: "followUp", args: ["t-task", "continue the work", false] },
    ]);

    setSnapshot(makeSnapshot(makeRow("needs-you"), { prompt, screenGeneration: 4 }));
    expect(
      await controller.submitComposer(identity, "2", {
        optionsOffered: true,
        promptKey: promptKey(prompt),
        screenGeneration: 4,
      }),
    ).toEqual({ kind: "sent" });
    expect(calls.filter(({ method }) => method === "answer")).toEqual([
      { method: "answer", args: ["t-task", ["down", "enter"]] },
    ]);
    expect(calls.filter(({ method }) => method === "followUp")).toHaveLength(1);
    expect(controller.isPromptAnswered(promptKey(prompt))).toBe(true);
    expect(runtime.sent).toBe(2);

    // Keep routing enabled after an answer: Sent hides the rows and the guard refuses
    // another typed choice instead of sending it as a forced follow-up.
    expect(
      await controller.submitComposer(identity, "1", {
        optionsOffered: true,
        promptKey: promptKey(prompt),
        screenGeneration: 4,
      }),
    ).toEqual({ kind: "refused", notice: "This menu has already been answered." });
    expect(calls.filter(({ method }) => method === "answer")).toEqual([
      { method: "answer", args: ["t-task", ["down", "enter"]] },
    ]);
    expect(calls.filter(({ method }) => method === "followUp")).toHaveLength(1);
    expect(runtime.sent).toBe(2);
  });

  test("keeps Type instead follow-up as a forced terminal send", async () => {
    const prompt = makePrompt();
    const { controller, calls } = makeController(
      makeSnapshot(makeRow("needs-you"), { prompt, screenGeneration: 4 }),
    );

    expect(
      await controller.submitComposer(makeIdentity(), "please explain the choice", {
        optionsOffered: false,
        promptKey: promptKey(prompt),
        screenGeneration: 4,
      }),
    ).toEqual({ kind: "sent" });
    expect(calls.filter(({ method }) => method === "followUp")).toEqual([
      { method: "followUp", args: ["t-task", "please explain the choice", true] },
    ]);
  });

  test("rejects a prompt answer when the displayed read generation is stale", async () => {
    const prompt = makePrompt();
    const { controller, calls } = makeController(
      makeSnapshot(makeRow("needs-you"), { prompt, screenGeneration: 9 }),
    );

    const result = await controller.answerPrompt(makeIdentity(), ["down", "enter"], {
      promptKey: promptKey(prompt),
      screenGeneration: 8,
    });
    const composerResult = await controller.submitComposer(makeIdentity(), "2", {
      optionsOffered: true,
      promptKey: promptKey(prompt),
      screenGeneration: 8,
    });

    expect(result.kind).toBe("refused");
    expect(composerResult.kind).toBe("refused");
    expect(calls.filter(({ method }) => method === "answer")).toEqual([]);
  });

  test("confirms stop and interrupt and sends nothing when either is canceled", async () => {
    const { controller, calls, setConfirmed } = makeController(makeSnapshot(makeRow("running")));
    setConfirmed(false);

    expect(await controller.selectMenuAction(makeIdentity(), "stop-agent")).toEqual({
      kind: "cancelled",
    });
    expect(await controller.selectMenuAction(makeIdentity(), "interrupt")).toEqual({
      kind: "cancelled",
    });
    expect(calls.filter(({ method }) => method === "confirm").map(({ args }) => args[0])).toEqual([
      {
        title: "Stop this agent?",
        cancelLabel: "Cancel",
        confirmLabel: "Stop agent",
      },
      {
        title: "Interrupt agent?",
        message: "Send Ctrl-C to this terminal.",
        confirmLabel: "Interrupt",
      },
    ]);
    expect(calls.filter(({ method }) => method === "stop" || method === "answer")).toEqual([]);
  });

  test("delivers confirmed stop and interrupt through task actions", async () => {
    const { controller, calls } = makeController(makeSnapshot(makeRow("running")));

    expect(await controller.selectMenuAction(makeIdentity(), "stop-agent")).toEqual({
      kind: "stopped",
    });
    expect(await controller.selectMenuAction(makeIdentity(), "interrupt")).toEqual({
      kind: "interrupted",
    });
    expect(calls.filter(({ method }) => method === "stop")).toEqual([
      { method: "stop", args: ["t-task"] },
    ]);
    expect(calls.filter(({ method }) => method === "answer")).toEqual([
      { method: "answer", args: ["t-task", ["ctrl+c"]] },
    ]);
  });

  test("delegates task check-off to runCheckOff", async () => {
    const { controller, calls, runCheckOffCalls } = makeController(makeSnapshot(makeRow("done")));

    expect(await controller.selectMenuAction(makeIdentity(), "check-off")).toEqual({
      kind: "check-off",
      result: "checked",
    });
    expect(runCheckOffCalls).toEqual([{ identity: makeIdentity(), choice: undefined }]);
    expect(calls.filter(({ method }) => method === "check")).toEqual([]);
  });

  test("refuses queued interrupt and answer after task state changes", async () => {
    const prompt = makePrompt();
    const waiting = deferred<boolean>();
    const confirmStarted = deferred<void>();
    const { controller, calls, setSnapshot, setConfirmHandler } = makeController(
      makeSnapshot(makeRow("needs-you"), { prompt, screenGeneration: 5 }),
    );
    setConfirmHandler(() => {
      confirmStarted.resolve();
      return waiting.promise;
    });

    const interrupt = controller.selectMenuAction(makeIdentity(), "interrupt");
    await confirmStarted.promise;
    const answer = controller.answerPrompt(makeIdentity(), ["down", "enter"], {
      promptKey: promptKey(prompt),
      screenGeneration: 5,
    });
    setSnapshot(makeSnapshot(makeRow("checked"), { prompt: undefined, screenGeneration: 6 }));
    waiting.resolve(true);

    expect(await interrupt).toEqual({ kind: "refused" });
    expect(await answer).toEqual({ kind: "refused" });
    expect(calls.filter(({ method }) => method === "answer")).toEqual([]);
  });

  test("formats the start fact with its device or Herdr source", () => {
    const startedToday = new Date(2026, 10, 15, 10, 2).getTime();
    const phoneRow = makeRow("running", {
      createdAt: startedToday,
      record: taskRecord("phone", {
        createdAt: startedToday,
        createdBy: { deviceId: "device-1", deviceName: "iPhone" },
      }),
    });
    expect(taskStartedFact(phoneRow, startedToday + 20_000)).toBe("Today, 10:02 from iPhone");

    const herdrRow = makeRow("running", {
      createdAt: new Date(2026, 10, 14, 10, 2).getTime(),
      fromHerdr: true,
      record: taskRecord("herdr", { origin: "herdr", text: undefined }),
    });
    expect(taskStartedFact(herdrRow, startedToday)).toBe("Nov 14, 10:02 from Herdr");
  });
});

function makeRow(
  state: TaskRow["state"],
  overrides: Omit<Partial<TaskRow>, "terminal"> & {
    terminal?: TaskRow["terminal"] | null;
  } = {},
): TaskRow {
  const record =
    overrides.record ??
    taskRecord("task", {
      terminal: overrides.unlinked ? undefined : "t-task",
      checkedTurn: state === "checked" ? 1 : undefined,
      createdAt: overrides.createdAt ?? 1_000,
    });
  const terminal = Object.hasOwn(overrides, "terminal")
    ? (overrides.terminal ?? undefined)
    : overrides.unlinked
      ? undefined
      : taskTerminal(overrides.address ?? "t-task", {
          turn: 1,
          state: state === "stopped" ? "finished" : "live",
          reason: state === "stopped" ? "exited" : undefined,
          status:
            state === "needs-you"
              ? { state: "blocked", msg: "Allow?" }
              : state === "done"
                ? { state: "done" }
                : { state: "working" },
        });

  return {
    id: record.id,
    record,
    address:
      overrides.address === undefined
        ? overrides.unlinked
          ? undefined
          : "t-task"
        : overrides.address,
    title: "Review the task",
    program: { name: "Claude Code", iconKey: "claude" },
    state,
    createdAt: overrides.createdAt ?? 1_000,
    timestamp: 2_000,
    age: "5m",
    project: { id: "project-1", name: "Project", folder: "/repo" },
    fromHerdr: false,
    unlinked: false,
    matched: false,
    checked: state === "checked",
    question: undefined,
    stoppedText: undefined,
    ...overrides,
    terminal,
    summarySource: overrides.summarySource ?? "phone",
  };
}

function makePrompt(): Prompt {
  return {
    question: "Choose one",
    choices: [
      { label: "First", keys: ["up", "enter"] },
      { label: "Second", keys: ["down", "enter"] },
    ],
  };
}

function makeIdentity(): TaskIdentity {
  return { machineId: "machine-1", taskId: taskRecord("task").id };
}

function makeSnapshot(
  row: TaskRow,
  overrides: Partial<TaskScreenSnapshot> = {},
): TaskScreenSnapshot {
  return {
    activeMachineId: "machine-1",
    role: "control",
    connection: "connected",
    row,
    prompt: undefined,
    screenGeneration: 1,
    ...overrides,
  };
}

function makeController(initialSnapshot: TaskScreenSnapshot) {
  const calls: { method: string; args: unknown[] }[] = [];
  const runCheckOffCalls: { identity: TaskIdentity; choice: unknown }[] = [];
  let snapshot = initialSnapshot;
  let confirmed = true;
  let confirmHandler: () => Promise<boolean> = async () => confirmed;
  let sent = 0;

  const actions: TaskActions = {
    start: async () => {
      throw new Error("Unused task action.");
    },
    check: async (...args) => {
      calls.push({ method: "check", args });
      return undefined;
    },
    uncheck: async (...args) => {
      calls.push({ method: "uncheck", args });
      return undefined;
    },
    link: async (...args) => {
      calls.push({ method: "link", args });
      return undefined;
    },
    clear: async (...args) => {
      calls.push({ method: "clear", args });
      return undefined;
    },
    stop: async (...args) => {
      calls.push({ method: "stop", args });
      return undefined;
    },
    followUp: async (...args) => {
      calls.push({ method: "followUp", args });
      return undefined;
    },
    answer: async (...args) => {
      calls.push({ method: "answer", args });
      return undefined;
    },
    confirm: async (...args) => {
      calls.push({ method: "confirm", args });
      return confirmHandler();
    },
    haptic: () => {
      calls.push({ method: "haptic", args: [] });
    },
    copy: async (...args) => {
      calls.push({ method: "copy", args });
    },
  };
  const runtime: TaskScreenRuntime = {
    current: () => snapshot,
    actions,
    runCheckOff: async (identity, choice) => {
      runCheckOffCalls.push({ identity, choice });
      return "checked";
    },
    markSent: () => {
      sent += 1;
    },
  };
  const controller = new TaskScreenController(() => runtime);

  return {
    controller,
    calls,
    runtime: {
      get sent() {
        return sent;
      },
    },
    runCheckOffCalls,
    setSnapshot(value: TaskScreenSnapshot) {
      snapshot = value;
    },
    setConfirmed(value: boolean) {
      confirmed = value;
      confirmHandler = async () => confirmed;
    },
    setConfirmHandler(handler: () => Promise<boolean>) {
      confirmHandler = handler;
    },
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    },
  };
}
