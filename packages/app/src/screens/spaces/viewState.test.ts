/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { MachineSpaceGroup } from "@/model/spaces.ts";
import {
  firstTerminalAddress,
  getSpaceExpansionKey,
  groupHeading,
  groupTag,
  initialExpandedSpaceKeys,
  minimumTapTarget,
  spacesFootnote,
  tabDotState,
  tabPillHitSlop,
  tabPillVisual,
  toggleExpandedSpace,
} from "./viewState.ts";

const groups: MachineSpaceGroup[] = [
  {
    id: "local",
    label: "this Mac",
    machine: undefined,
    spaces: [
      { id: "docs", name: "Docs", state: "idle", tabs: [] },
      { id: "api", name: "API", state: "working", tabs: [] },
    ],
  },
  {
    id: "remote:box",
    label: "box",
    machine: "box",
    spaces: [{ id: "docs", name: "Docs", state: "blocked", tabs: [] }],
  },
];

describe("spaces view state", () => {
  test("keeps pill hit targets at least 44 points in both dimensions", () => {
    expect(
      tabPillVisual.height + tabPillHitSlop.top + tabPillHitSlop.bottom,
    ).toBeGreaterThanOrEqual(minimumTapTarget);
    expect(
      tabPillVisual.addWidth + tabPillHitSlop.left + tabPillHitSlop.right,
    ).toBeGreaterThanOrEqual(minimumTapTarget);
  });

  test("opens the first space by default and distinguishes same-named spaces per machine", () => {
    expect(initialExpandedSpaceKeys(groups)).toEqual([getSpaceExpansionKey("local", "docs")]);
    expect(getSpaceExpansionKey("local", "docs")).not.toBe(
      getSpaceExpansionKey("remote:box", "docs"),
    );
  });

  test("toggles an expanded space without mutating the current keys", () => {
    const initial = [getSpaceExpansionKey("local", "docs")];
    const collapsed = toggleExpandedSpace(initial, initial[0] ?? "");

    expect(collapsed).toEqual([]);
    expect(initial).toHaveLength(1);
    expect(toggleExpandedSpace(collapsed, getSpaceExpansionKey("local", "api"))).toEqual([
      getSpaceExpansionKey("local", "api"),
    ]);
  });

  test("uses the paired Mac name locally and SSH tags for remote machine groups", () => {
    const [localGroup, remoteGroup] = groups;
    if (localGroup === undefined || remoteGroup === undefined) throw new Error("Missing fixture");

    expect(groupHeading(localGroup, "MacBook Pro")).toBe("MacBook Pro");
    expect(groupTag(localGroup)).toBe("this Mac");
    expect(groupHeading(remoteGroup, "MacBook Pro")).toBe("box");
    expect(groupTag(remoteGroup)).toBe("ssh");
  });

  test("keeps the spaces footnote copy from the UI kit mockup", () => {
    expect(spacesFootnote).toBe(
      "New spaces and tabs open in Herdr on your Mac, so it has to be running.",
    );
  });

  test("shows tab dots for blocked and done states only", () => {
    expect([
      tabDotState("blocked"),
      tabDotState("done"),
      tabDotState("working"),
      tabDotState("idle"),
    ]).toEqual(["blocked", "done", undefined, undefined]);
  });

  test("targets the first terminal in a tab", () => {
    expect(firstTerminalAddress([{ address: "box/first" }, { address: "later" }])).toBe(
      "box/first",
    );
    expect(firstTerminalAddress([])).toBeUndefined();
  });
});
