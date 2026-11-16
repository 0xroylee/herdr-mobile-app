/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Layout, Terminal } from "@herdr-mobile/protocol";
import type { SpaceRow } from "../../model/spaces.ts";
import {
  findProjectSpace,
  firstTerminalAddress,
  projectTaskId,
  tabDotState,
  tabPillHitSlop,
  terminalsListContentClassName,
  terminalsListScrollClassName,
  transitionPickerVisibility,
} from "./viewState.ts";

describe("picker availability", () => {
  test("closes an open picker when disabled and rejects opens until enabled again", () => {
    let visible = transitionPickerVisibility(false, { type: "open", disabled: false });
    expect(visible).toBe(true);

    visible = transitionPickerVisibility(visible, {
      type: "availability-changed",
      disabled: true,
    });
    expect(visible).toBe(false);
    expect(transitionPickerVisibility(visible, { type: "open", disabled: true })).toBe(false);
    expect(
      transitionPickerVisibility(visible, { type: "availability-changed", disabled: false }),
    ).toBe(false);
    expect(transitionPickerVisibility(visible, { type: "open", disabled: false })).toBe(true);
  });
});

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

  test("selects a layout space by id when names repeat and leaves empty spaces empty", () => {
    const spaces = [space("first", "Website"), space("later", "Website")];
    const layout = { spaces: [{ id: "first" }, { id: "later" }] } as unknown as Layout;

    expect(findProjectSpace("later", layout, spaces)).toBe(spaces[1]);
    expect(findProjectSpace("empty", layout, spaces)).toBeUndefined();
  });

  test("translates label-backed project ids without matching display names", () => {
    const spaces = [
      space("label-space:site-a", "Website", "site-a"),
      space("label-space:site-b", "Website", "site-b"),
    ];

    expect(projectTaskId("label-space:site-b", undefined)).toBe("site-b");
    expect(findProjectSpace("site-b", undefined, spaces)).toBe(spaces[1]);
  });

  test("gives overflowing pills a bounded, wrapping scroll container", () => {
    expect(terminalsListScrollClassName).toContain("min-h-0 flex-1");
    expect(terminalsListContentClassName).toContain("flex-row flex-wrap");
    expect(terminalsListContentClassName).toContain("content-start");
  });
});

function space(id: string, name: string, label = id): SpaceRow {
  const terminal = {
    address: `terminal-${id}`,
    labels: { "herdr.space": label },
  } as unknown as Terminal;
  return {
    id,
    name,
    state: "idle",
    tabs: [{ id: `tab-${id}`, name: "Main", state: "idle", terminals: [terminal] }],
  };
}
