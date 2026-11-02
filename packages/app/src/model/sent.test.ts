/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { isSent, markSent, SENT_TIMEOUT_MS, updateSent } from "./sent.ts";

describe("Sent state", () => {
  test("stays visible until a working status or 20 seconds", () => {
    const sent = markSent(1_000);
    expect(isSent(sent, { state: "blocked" }, 1_000 + SENT_TIMEOUT_MS - 1)).toBe(true);
    expect(updateSent(sent, { state: "blocked" }, 1_000 + SENT_TIMEOUT_MS)).toBeUndefined();
    expect(updateSent(sent, { state: "working" }, 1_001)).toBeUndefined();
  });

  test("has no state before a send", () => {
    expect(isSent(undefined, { state: "blocked" }, 1_000)).toBe(false);
    expect(updateSent(undefined, null, 1_000)).toBeUndefined();
  });
});
