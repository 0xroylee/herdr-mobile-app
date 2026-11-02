/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { isAddressSeen, isSeen, markSeen, seenKey } from "./seen.ts";

describe("seen turns", () => {
  test("uses the documented machine and address key", () => {
    expect(seenKey("mac-id", "box/t7")).toBe("seen.mac-id.box/t7");
    const next = markSeen({}, "mac-id", "box/t7", 4);
    expect(next).toEqual({ "seen.mac-id.box/t7": 4 });
    expect(isSeen(next, "mac-id", "box/t7", 4)).toBe(true);
    expect(isSeen(next, "mac-id", "box/t7", 5)).toBe(false);
  });

  test("address lookup is exact to the active machine and turn", () => {
    const seen = { "seen.mac-id.t7": 3 };
    expect(isAddressSeen(seen, "mac-id", "t7", 3)).toBe(true);
    expect(isAddressSeen(seen, "mac-other", "t7", 3)).toBe(false);
    expect(isAddressSeen(seen, "mac-id", "t7", 4)).toBe(false);
    expect(isAddressSeen(seen, "mac-id", "t7", undefined)).toBe(false);
  });
});
