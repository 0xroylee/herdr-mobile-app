/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "./generated/hc-api.ts";
import { isEnded, stoppedText, taskState } from "./task-state.ts";
import type { TaskRecord } from "./tasks.ts";

function taskRecord(suffix: string, values: Partial<TaskRecord> = {}): TaskRecord {
  const id = `tk${suffix.padStart(32, "0")}`;
  return {
    origin: "phone",
    text: "Review the task\n\nKeep the API stable.",
    run: { kind: "program", id: "claude" },
    folder: "/repo",
    createdAt: 10_000,
    ...values,
    id: values.id ?? id,
  };
}

function taskTerminal(address: string, values: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1_000,
    cwd: "/repo",
    labels: {},
    reported: true,
    rows: 24,
    screen: "exact",
    state: "live",
    status: { state: "working" },
    status_ms: 2_000,
    turn: 1,
    ...values,
  };
}

describe("task state", () => {
  test.each([
    ["checked on the same turn", 1, "working", 1, "checked"],
    ["checked when an ended terminal has the same turn", 1, "finished", 1, "checked"],
    ["returns to running on a later turn", 1, "working", 2, "running"],
    ["stays checked when the later turn ends", 1, "finished", 2, "checked"],
  ] as const)("%s", (_label, checkedTurn, terminalState, turn, expected) => {
    const terminal = taskTerminal("t1", {
      state: terminalState,
      reason: terminalState === "finished" ? "exited" : undefined,
      turn,
      status: { state: terminalState === "finished" ? "done" : "working" },
    });
    expect(taskState(taskRecord("1", { checkedTurn }), terminal, terminal.status)).toBe(expected);
  });

  test("keeps a checked task checked when a kept terminal has a reason at a later turn", () => {
    const terminal = taskTerminal("t1", {
      state: "live",
      reason: "signaled",
      turn: 2,
      status: { state: "working" },
    });
    expect(taskState(taskRecord("1", { checkedTurn: 1 }), terminal, terminal.status)).toBe(
      "checked",
    );
  });

  test.each([
    [
      "done status survives a nonzero exit",
      { state: "finished", exit_code: 1 },
      { state: "done" },
      "done",
    ],
    [
      "clean exit after a finished turn is Done",
      { state: "finished", exit_code: 0, turn: 1 },
      null,
      "done",
    ],
    [
      "unclean exit without done evidence is Stopped",
      { state: "finished", exit_code: 1 },
      { state: "working" },
      "stopped",
    ],
    [
      "a kept terminal that lost its process is Stopped",
      { state: "live", reason: "signaled", signal: 9 },
      { state: "working" },
      "stopped",
    ],
    [
      "blocked status needs the user",
      { state: "live" },
      { state: "blocked", msg: "Allow?" },
      "needs-you",
    ],
    ["error status needs the user", { state: "live" }, { state: "error" }, "needs-you"],
    ["working status is Running", { state: "live" }, { state: "working" }, "running"],
    [
      "idle before the first turn is Running",
      { state: "live", turn: 0 },
      { state: "idle" },
      "running",
    ],
    ["idle after a turn is Done", { state: "live", turn: 1 }, { state: "idle" }, "done"],
    ["no status report is Running", { state: "live", status: null }, null, "running"],
  ] as const)("%s", (_label, terminalValues, status, expected) => {
    const terminal =
      terminalValues === undefined
        ? undefined
        : taskTerminal("t1", {
            ...terminalValues,
            status: status === null ? null : status,
          });
    expect(taskState(taskRecord("1"), terminal, status)).toBe(expected);
  });

  test("uses the current live status instead of a conflicting last-seen status", () => {
    const working = taskTerminal("t-working", { status: { state: "working" } });
    const blocked = taskTerminal("t-blocked", { status: { state: "blocked", msg: "Allow?" } });

    expect(taskState(taskRecord("1"), working, { state: "done" })).toBe("running");
    expect(taskState(taskRecord("2"), blocked, { state: "working" })).toBe("needs-you");
  });

  test("uses the phone's last-seen status when the terminal snapshot has no status", () => {
    const terminal = taskTerminal("t1", { state: "finished", status: null, exit_code: 1 });
    expect(taskState(taskRecord("1"), terminal, { state: "done" })).toBe("done");
    expect(taskState(taskRecord("2", { checkedTurn: 1 }), undefined, undefined)).toBe("checked");
  });

  test("a linked record whose terminal is missing is Stopped", () => {
    expect(taskState(taskRecord("1", { terminal: "t-missing" }), undefined, undefined)).toBe(
      "stopped",
    );
  });

  test("treats an unrecognized live status as Running", () => {
    const terminal = taskTerminal("t1", { status: { state: "unknown" } });
    expect(taskState(taskRecord("1"), terminal, terminal.status)).toBe("running");
  });

  test("formats stopped text from the terminal exit details", () => {
    const stoppedTexts = [
      stoppedText(taskTerminal("t-code", { state: "finished", reason: "exited", exit_code: 7 })),
      stoppedText(taskTerminal("t-signal", { state: "live", reason: "signaled", signal: 9 })),
      stoppedText(
        taskTerminal("t-ended", { state: "finished", reason: "exited", exit_code: null }),
      ),
    ];
    expect(stoppedTexts).toEqual([
      "Exited with code 7 before it finished.",
      "Stopped by 9 before it finished.",
      "Ended before it finished.",
    ]);
    expect(stoppedText(undefined)).toBe("The terminal is gone.");
  });

  test("considers a missing, finished, or replaced terminal ended", () => {
    expect(isEnded(undefined)).toBe(true);
    expect(isEnded(taskTerminal("t-live"))).toBe(false);
    expect(isEnded(taskTerminal("t-finished", { state: "finished" }))).toBe(true);
    expect(isEnded(taskTerminal("t-replaced", { reason: "signaled" }))).toBe(true);
  });
});
