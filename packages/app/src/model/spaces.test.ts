/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Layout, Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces } from "./spaces.ts";

const terminal = (
  address: string,
  state: string,
  labels: Record<string, string> = {},
): Terminal => ({
  address,
  argv: ["codex"],
  cols: 80,
  created_ms: 1,
  cwd: "/repo",
  labels,
  rows: 24,
  screen: "exact",
  state: "live",
  status: { state },
});

const layout: Layout = {
  spaces: [
    {
      id: "second",
      name: "Second in document",
      folder: null,
      tabs: [
        { id: "b", name: "B tab", terminalAddresses: ["t2"] },
        { id: "a", name: "A tab", terminalAddresses: ["t1", "t3"] },
      ],
    },
    {
      id: "first",
      name: "Next in document",
      folder: null,
      tabs: [{ id: "c", name: "C tab", terminalAddresses: ["box/t4"] }],
    },
  ],
};

describe("deriveSpaces", () => {
  test("preserves document space and tab order and derives urgency", () => {
    const result = deriveSpaces(
      [
        terminal("t1", "working"),
        terminal("t2", "blocked"),
        terminal("t3", "done"),
        terminal("box/t4", "working"),
      ],
      layout,
    );
    expect(result.map(({ label }) => label)).toEqual(["this Mac", "box"]);
    expect(result[0]?.spaces.map(({ name }) => name)).toEqual(["Second in document"]);
    expect(result[0]?.spaces[0]).toMatchObject({
      state: "blocked",
      tabs: [
        { name: "B tab", state: "blocked" },
        { name: "A tab", state: "done" },
      ],
    });
    expect(result[1]?.spaces.map(({ name }) => name)).toEqual(["Next in document"]);
    expect(result[1]?.spaces[0]?.tabs[0]?.terminals[0]?.address).toBe("box/t4");
  });

  test("keeps layout tabs and places terminals absent from the document under Other", () => {
    const result = deriveSpaces([terminal("t1", "working"), terminal("box/t9", "blocked")], layout);
    expect(result[0]?.spaces.map(({ name }) => name)).toEqual(["Second in document"]);
    expect(result[0]?.spaces[0]?.tabs.map(({ name }) => name)).toEqual(["B tab", "A tab"]);
    expect(result[1]?.spaces.map(({ name }) => name)).toEqual(["Next in document", "Other"]);
    expect(result[1]?.spaces[1]?.tabs[0]?.terminals.map(({ address }) => address)).toEqual([
      "box/t9",
    ]);
  });

  test("falls back to herdr.space and herdr.tab labels without a document", () => {
    const result = deriveSpaces(
      [
        terminal("t1", "working", { "herdr.space": "Docs", "herdr.tab": "Nav" }),
        terminal("t2", "done", { "herdr.space": "Docs", "herdr.tab": "Copy" }),
        terminal("box/t3", "idle", { "herdr.space": "API", "herdr.tab": "Server" }),
        terminal("t4", "idle"),
      ],
      undefined,
    );
    expect(result.map(({ label }) => label)).toEqual(["this Mac", "box"]);
    expect(result[0]?.spaces.map(({ name }) => name)).toEqual(["Docs", "Other"]);
    expect(result[0]?.spaces[0]?.tabs.map(({ name }) => name)).toEqual(["Nav", "Copy"]);
    expect(result[0]?.spaces[0]?.state).toBe("done");
    expect(result[0]?.spaces[1]?.name).toBe("Other");
  });

  test("supports an empty document by keeping its space and tab visible as idle", () => {
    const emptyLayout: Layout = {
      spaces: [
        {
          id: "empty",
          name: "Empty",
          folder: null,
          tabs: [{ id: "tab", name: "Tab", terminalAddresses: [] }],
        },
      ],
    };
    const result = deriveSpaces([], emptyLayout);
    expect(result[0]?.spaces[0]).toMatchObject({
      name: "Empty",
      state: "idle",
      tabs: [{ name: "Tab", state: "idle", terminals: [] }],
    });
  });

  test("keeps a remote machine named this separate from the local group with a layout", () => {
    const collisionLayout: Layout = {
      spaces: [
        {
          id: "shared",
          name: "Shared",
          folder: null,
          tabs: [{ id: "both", name: "Both", terminalAddresses: ["t1", "this/t2"] }],
        },
      ],
    };
    const result = deriveSpaces(
      [terminal("t1", "working"), terminal("this/t2", "blocked")],
      collisionLayout,
    );

    expect(result.map(({ id, label, machine }) => [id, label, machine])).toEqual([
      ["local", "this Mac", undefined],
      ["remote:this", "this", "this"],
    ]);
    expect(result[0]?.spaces[0]?.tabs[0]?.terminals.map(({ address }) => address)).toEqual(["t1"]);
    expect(result[1]?.spaces[0]?.tabs[0]?.terminals.map(({ address }) => address)).toEqual([
      "this/t2",
    ]);
  });

  test("keeps a remote machine named this separate from local label fallback", () => {
    const result = deriveSpaces(
      [
        terminal("t1", "working", { "herdr.space": "Shared" }),
        terminal("this/t2", "blocked", { "herdr.space": "Shared" }),
      ],
      undefined,
    );

    expect(result.map(({ id, label, machine }) => [id, label, machine])).toEqual([
      ["local", "this Mac", undefined],
      ["remote:this", "this", "this"],
    ]);
    expect(result[0]?.spaces[0]?.tabs[0]?.terminals.map(({ address }) => address)).toEqual(["t1"]);
    expect(result[1]?.spaces[0]?.tabs[0]?.terminals.map(({ address }) => address)).toEqual([
      "this/t2",
    ]);
  });
});
