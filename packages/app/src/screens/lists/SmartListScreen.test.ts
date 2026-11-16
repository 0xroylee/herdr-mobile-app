/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskSummaryRow } from "../project/project-view.ts";
import { cacheTaskSummaryReadByMachine, taskSummaryKey } from "../project/project-view.ts";

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
});
