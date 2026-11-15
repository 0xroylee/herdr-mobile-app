/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { firstTerminalAddress, tabDotState, tabPillHitSlop } from "./viewState.ts";

describe("project terminal pill view state", () => {
  test("shows a dot only for blocked and done tabs", () => {
    expect(tabDotState("blocked")).toBe("blocked");
    expect(tabDotState("done")).toBe("done");
    expect(tabDotState("working")).toBeUndefined();
    expect(tabDotState("idle")).toBeUndefined();
  });

  test("opens the first terminal in a tab and has a forgiving hit target", () => {
    expect(firstTerminalAddress([{ address: "t1" }, { address: "t2" }])).toBe("t1");
    expect(firstTerminalAddress([])).toBeUndefined();
    expect(tabPillHitSlop).toEqual({ top: 7, bottom: 7, left: 6, right: 6 });
  });
});
