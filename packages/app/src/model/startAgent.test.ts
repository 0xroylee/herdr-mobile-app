/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { AgentCatalog, Layout, Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces } from "./spaces.ts";
import {
  deriveStartOptions,
  findSpaceForTarget,
  firstMessageNeedsWindow,
  startPlacementNotice,
  validateStartDraft,
} from "./startAgent.ts";

describe("start agent model", () => {
  test("derives allowed runs, spaces, and ordered folder suggestions", () => {
    const options = deriveStartOptions(
      catalog(),
      layout(),
      [terminal("t1", "/Users/roy/src/other"), terminal("t2", "/Users/roy/src/herdr")],
      ["/Users/roy/last", "/Users/roy/src/other"],
      "sp-work",
    );

    expect(options.runChoices.map(({ name }) => name)).toEqual([
      "Claude Code",
      "Codex",
      "review",
      "Empty tab",
    ]);
    expect(options.spaceChoices).toEqual([
      {
        selection: { kind: "existing", id: "sp-work" },
        displayId: "sp-work",
        name: "Work",
        folder: "/Users/roy/src",
      },
      { selection: { kind: "new" }, name: "New space" },
    ]);
    expect(options.foldersBySpace["sp-work"]).toEqual([
      { path: "/Users/roy/src", source: "space" },
      { path: "/Users/roy/src/herdr", source: "terminal" },
      { path: "/Users/roy/src/other", source: "terminal" },
      { path: "/Users/roy/last", source: "recent" },
    ]);
    expect(options.foldersBySpace.new).toEqual([
      { path: "/Users/roy/last", source: "recent" },
      { path: "/Users/roy/src/other", source: "recent" },
    ]);
  });

  test("offers built-in runs when the catalog could not be loaded", () => {
    const options = deriveStartOptions(undefined, undefined, [], [], undefined);

    expect(options.runChoices.map(({ name }) => name)).toEqual(["Claude Code", "Codex"]);
    expect(options.spaceChoices).toEqual([{ selection: { kind: "new" }, name: "New space" }]);
  });

  test("uses real label targets while keeping the display row key", () => {
    const labelTerminal = { ...terminal("t1", "/Users/roy/src"), labels: { "herdr.space": "sp1" } };
    const options = deriveStartOptions(
      undefined,
      undefined,
      [labelTerminal],
      [],
      "label-space:sp1",
    );

    expect(options.spaceChoices).toEqual([
      {
        selection: { kind: "existing", id: "sp1" },
        displayId: "label-space:sp1",
        name: "sp1",
      },
      { selection: { kind: "new" }, name: "New space" },
    ]);
    expect(
      findSpaceForTarget(
        "sp1",
        [
          {
            id: "label-space:sp1",
            name: "sp1",
            state: "idle",
            tabs: [
              {
                id: "label-tab:sp1:Other",
                name: "Other",
                state: "idle",
                terminals: [labelTerminal],
              },
            ],
          },
        ],
        undefined,
      )?.id,
    ).toBe("label-space:sp1");
  });

  test("omits unresolved aggregate spaces as existing destinations", () => {
    const aggregate = { ...terminal("t1", "/Users/roy/src"), labels: {} };
    const options = deriveStartOptions(undefined, undefined, [aggregate], [], undefined);

    const aggregateRow = deriveSpaces([aggregate], undefined)[0]?.spaces[0];

    expect(options.spaceChoices).toEqual([{ selection: { kind: "new" }, name: "New space" }]);
    expect(aggregateRow).toBeDefined();
    expect(
      findSpaceForTarget("other", aggregateRow ? [aggregateRow] : [], undefined),
    ).toBeUndefined();
  });

  test("maps a placement id by its resolved target even when it resembles a display key", () => {
    const labelRows = deriveSpaces(
      [
        { ...terminal("t1", "/Users/roy/src"), labels: { "herdr.space": "sp1" } },
        { ...terminal("t2", "/Users/roy/src"), labels: { "herdr.space": "label-space:sp1" } },
      ],
      undefined,
    )[0]?.spaces;

    expect(labelRows).toBeDefined();
    expect(findSpaceForTarget("label-space:sp1", labelRows ?? [], undefined)?.name).toBe(
      "label-space:sp1",
    );
  });

  test("requires an open Herdr window for built-in first messages only", () => {
    expect(
      firstMessageNeedsWindow(
        { ...catalog(), windowOpen: false },
        { kind: "program", id: "claude" },
      ),
    ).toBe(true);
    expect(
      firstMessageNeedsWindow(
        { ...catalog(), windowOpen: false },
        { kind: "template", name: "review" },
      ),
    ).toBe(false);
    expect(firstMessageNeedsWindow(catalog(), { kind: "program", id: "claude" })).toBe(false);
  });

  test("describes both start placements in the agent notice", () => {
    expect(startPlacementNotice("core")).toBe(
      "Started in herdr-core. Herdr shows it when it opens.",
    );
    expect(startPlacementNotice("window")).toBe("Started in Herdr.");
  });

  test("validates a start draft and omits a blank optional message", () => {
    expect(
      validateStartDraft({
        run: { kind: "template", name: "review" },
        folder: " ~/src/herdr ",
        space: { kind: "existing", id: "sp-work" },
        task: "  ",
      }),
    ).toEqual({
      ok: true,
      request: {
        run: { kind: "template", name: "review" },
        folder: "~/src/herdr",
        space: { kind: "existing", id: "sp-work" },
      },
    });
  });

  test("reports missing and unsafe draft fields", () => {
    expect(
      validateStartDraft({
        run: undefined,
        folder: "../project",
        space: { kind: "existing", id: " " },
        task: "  build it  ",
      }),
    ).toEqual({
      ok: false,
      errors: {
        run: "Choose a program or template.",
        folder: "Enter an absolute path or a path starting with ~/.",
        space: "Choose a space.",
      },
    });
  });

  test("requires a folder for a new space and trims its optional name and message", () => {
    expect(
      validateStartDraft({
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "new", name: "  Research  " },
        task: "  Investigate this repo  ",
      }),
    ).toEqual({
      ok: true,
      request: {
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "new", name: "Research" },
        task: "Investigate this repo",
      },
    });
  });
});

function catalog(): AgentCatalog {
  return {
    programs: ["claude", "codex"],
    templates: [{ name: "review", description: "Review changes" }],
    roots: ["/Users/roy"],
    home: "/Users/roy",
    windowOpen: true,
  };
}

function layout(): Layout {
  return {
    spaces: [
      {
        id: "sp-work",
        name: "Work",
        folder: "/Users/roy/src",
        tabs: [
          { id: "tb1", name: "Main", terminalAddresses: ["t2", "t1"] },
          { id: "tb2", name: "Scratch", terminalAddresses: [] },
        ],
      },
    ],
  };
}

function terminal(address: string, cwd: string): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd,
    labels: { "herdr.space": "sp-work" },
    rows: 24,
    screen: "exact",
    state: "live",
  };
}
