/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskSummaryRow } from "../project/project-view.ts";
import {
  cacheTaskSummaryReadByMachine,
  shouldReadTaskSummary,
  taskSummary,
  taskSummaryKey,
} from "../project/project-view.ts";

describe("smart list summary cache", () => {
  test("caches a successful read for a finished terminal with reason exited", () => {
    const row = {
      id: "task-finished",
      address: "terminal-finished",
      terminal: {
        address: "terminal-finished",
        state: "finished",
        reason: "exited",
        keep: true,
        exit_code: 0,
        turn: 4,
      },
    } as unknown as TaskSummaryRow;

    const cache = cacheTaskSummaryReadByMachine(
      { otherMac: { existing: "Other Mac summary" } },
      "thisMac",
      row,
      row.terminal,
      "Finished the task",
    );

    expect(cache).toEqual({
      otherMac: { existing: "Other Mac summary" },
      thisMac: { [taskSummaryKey(row)]: "Finished the task" },
    });
  });

  test("uses a bridge summary in Done and skips a phone screen read", () => {
    const row = {
      id: "task-done",
      address: "terminal-done",
      state: "done",
      summary: "Bridge summary",
      summarySource: "bridge",
      terminal: {
        address: "terminal-done",
        state: "finished",
        reason: "exited",
        turn: 4,
      },
    } as unknown as TaskSummaryRow;

    expect(taskSummary(row, {})).toBe("Bridge summary");
    expect(shouldReadTaskSummary(row, {})).toBe(false);
  });
});
