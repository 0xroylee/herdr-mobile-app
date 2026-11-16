/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { pairedTasksMessage } from "./connection-line-state.ts";

describe("pairing completion copy", () => {
  test("says pairing returns to the task list", () => {
    expect(pairedTasksMessage("MacBook Pro")).toBe("Paired with MacBook Pro. Opening your tasks…");
  });
});
