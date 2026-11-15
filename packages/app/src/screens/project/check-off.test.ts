/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskRow } from "../../model/tasks.ts";
import { applyCheckOff, checkOffSheetOptions, needsCheckOffSheet } from "./check-off.ts";

describe("check-off sheet", () => {
  for (const state of [
    "running",
    "needs-you",
    "done",
    "stopped",
    "checked",
    "not-started",
  ] as const) {
    test(`chooses the sheet behavior for ${state}`, () => {
      const task = row(state);
      expect(needsCheckOffSheet(task, "control")).toBe(
        state === "running" || state === "needs-you",
      );
      expect(checkOffSheetOptions(task, "control").map(({ label }) => label)).toEqual(
        state === "running" || state === "needs-you"
          ? ["Stop agent and check off", "Check off, keep it running", "Cancel"]
          : [],
      );
      expect(needsCheckOffSheet(task, "watch")).toBe(false);
      expect(checkOffSheetOptions(task, "watch")).toEqual([]);
    });
  }

  test("omits stopping when a running task has no linked terminal", () => {
    const task = row("running", { address: undefined, record: true });
    expect(checkOffSheetOptions(task, "control").map(({ id }) => id)).toEqual([
      "keep-running",
      "cancel",
    ]);
  });

  test("stops before checking a running task at its live turn", async () => {
    const calls: unknown[] = [];
    const task = row("running", { turn: 4 });

    await expect(
      applyCheckOff(task, "control", "stop", {
        stop: async (address) => calls.push(["stop", address]),
        check: async (request) => calls.push(["check", request]),
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      ["stop", "terminal-running"],
      ["check", { id: "task-running", turn: 4 }],
    ]);
  });

  test("keeps a needs-you agent running while checking it off", async () => {
    const calls: unknown[] = [];
    await applyCheckOff(row("needs-you", { turn: 2 }), "control", "keep-running", {
      stop: async (address) => calls.push(["stop", address]),
      check: async (request) => calls.push(["check", request]),
    });
    expect(calls).toEqual([["check", { id: "task-needs-you", turn: 2 }]]);
  });

  test("checks Done and Stopped without a sheet", async () => {
    for (const state of ["done", "stopped"] as const) {
      const requests: unknown[] = [];
      expect(
        await applyCheckOff(row(state), "control", undefined, {
          stop: async () => {
            throw new Error("Done tasks are not stopped");
          },
          check: async (request) => requests.push(request),
        }),
      ).toBe(true);
      expect(requests).toEqual([{ id: `task-${state}`, turn: 0 }]);
    }
  });

  test("checks an unrecorded Herdr task by terminal address", async () => {
    const requests: unknown[] = [];
    await applyCheckOff(row("done", { record: false }), "control", undefined, {
      stop: async () => {},
      check: async (request) => requests.push(request),
    });
    expect(requests).toEqual([{ terminal: "terminal-done", turn: 0 }]);
  });

  test("does not change tasks for a watch device or a cancelled sheet", async () => {
    const calls: string[] = [];
    const actions = {
      stop: async () => calls.push("stop"),
      check: async () => calls.push("check"),
    };
    await expect(applyCheckOff(row("running"), "watch", "stop", actions)).resolves.toBe(false);
    await expect(applyCheckOff(row("running"), "control", "cancel", actions)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

function row(
  state: TaskRow["state"],
  options: { address?: string; record?: boolean; turn?: number } = {},
): TaskRow {
  const address = Object.hasOwn(options, "address") ? options.address : `terminal-${state}`;
  const record = options.record === false ? undefined : { id: `task-${state}` };
  return {
    id: `task-${state}`,
    record: record as unknown as TaskRow["record"],
    address,
    terminal:
      options.turn === undefined
        ? undefined
        : ({ turn: options.turn } as unknown as TaskRow["terminal"]),
    title: state,
    program: { name: "Claude Code", iconKey: "claude" },
    state,
    createdAt: 1,
    timestamp: 1,
    age: "1m",
    project: { id: "website", name: "Website", folder: undefined },
    fromHerdr: options.record === false,
    unlinked: address === undefined,
    matched: false,
    checked: state === "checked",
    question: undefined,
    stoppedText: undefined,
  };
}
