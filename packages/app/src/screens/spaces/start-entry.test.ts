/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import type { SpaceRow } from "../../model/spaces.ts";
import type { SpaceTargetId } from "../../model/spaceTarget.ts";
import { spaceStartTarget } from "./start-entry.ts";

describe("Space Start entry point", () => {
  test("returns a target for a control device and a resolvable row", () => {
    const row = labelSpaceRow([terminal("t1", "sp1")]);

    expect(spaceStartTarget("control", row, undefined)).toBe("sp1" as SpaceTargetId);
  });

  test("does not return a target for a watch device", () => {
    const row = labelSpaceRow([terminal("t1", "sp1")]);

    expect(spaceStartTarget("watch", row, undefined)).toBeUndefined();
  });

  test("does not return a target for an Other row", () => {
    const row = labelSpaceRow([terminal("t1", undefined)]);

    expect(spaceStartTarget("control", row, undefined)).toBeUndefined();
  });

  test("does not return a target for a row with mixed labels", () => {
    const row = labelSpaceRow([terminal("t1", "sp1"), terminal("t2", "sp2")]);

    expect(spaceStartTarget("control", row, undefined)).toBeUndefined();
  });
});

function labelSpaceRow(terminals: readonly Terminal[]): SpaceRow {
  return {
    id: "label-space:sp1",
    name: "sp1",
    state: "idle",
    tabs: [
      {
        id: "label-tab:sp1:Main",
        name: "Main",
        state: "idle",
        terminals: [...terminals],
      },
    ],
  };
}

function terminal(address: string, spaceId: string | undefined): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: "/Users/roy/project",
    labels: { ...(spaceId === undefined ? {} : { "herdr.space": spaceId }) },
    rows: 24,
    screen: "exact",
    state: "live",
  };
}
