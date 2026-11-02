/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { compareUrgency, effectiveState, mostUrgent, urgencyOrder } from "./status.ts";

describe("effective status", () => {
  test("maps protocol states and treats unknown or missing states as idle", () => {
    expect(effectiveState({ state: "blocked" })).toBe("blocked");
    expect(effectiveState({ state: "error" })).toBe("blocked");
    expect(effectiveState({ state: "done" })).toBe("done");
    expect(effectiveState({ state: "working" })).toBe("working");
    expect(effectiveState({ state: "idle" })).toBe("idle");
    expect(effectiveState({ state: "waiting_for_magic" })).toBe("idle");
    expect(effectiveState(null)).toBe("idle");
  });

  test("unknown and cleared statuses stay idle on finished terminals", () => {
    expect(effectiveState({ state: "future-state" }, { terminalState: "finished" })).toBe("idle");
    expect(effectiveState(null, { terminalState: "finished" })).toBe("idle");
  });

  test("a seen done terminal becomes idle while errors stay blocked", () => {
    expect(effectiveState({ state: "done" }, { seen: true })).toBe("idle");
    expect(effectiveState({ state: "error" }, { seen: true })).toBe("blocked");
  });

  test("urgency puts blocked, done, working and idle in that order", () => {
    expect(urgencyOrder).toEqual(["blocked", "done", "working", "idle"]);
    expect(compareUrgency("blocked", "done")).toBeLessThan(0);
    expect(mostUrgent(["idle", "working", "done"])).toBe("done");
    expect(mostUrgent([])).toBe("idle");
  });
});
