/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Layout, Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces, type SpaceRow } from "@/model/spaces.ts";
import { newTabTarget, type SpaceTargetId } from "./spaceTarget.ts";

function terminal(address: string, labels: Record<string, string> = {}): Terminal {
  return {
    address,
    argv: ["codex"],
    cols: 80,
    created_ms: 1,
    cwd: "/repo",
    labels,
    rows: 24,
    screen: "exact",
    state: "live",
    status: { state: "idle" },
  };
}

function spaceRow(id: string, tabId: string, name = "Docs", terminals: Terminal[] = []): SpaceRow {
  return {
    id,
    name,
    state: "idle",
    tabs: [{ id: tabId, name, state: "idle", terminals }],
  };
}

function layout(
  id: string,
  tabId: string,
  name = "Docs",
  terminalAddresses: string[] = [],
): Layout {
  return {
    spaces: [
      {
        id,
        name,
        folder: null,
        tabs: [{ id: tabId, name, terminalAddresses }],
      },
    ],
  };
}

function labelSpace(labels: Record<string, string>[]): SpaceRow {
  const terminals = labels.map((terminalLabels, index) => terminal(`t${index}`, terminalLabels));
  const group = deriveSpaces(terminals, undefined)[0];
  const space = group?.spaces[0];
  if (space === undefined) throw new Error("Expected a label-backed space row");
  return space;
}

function expectTarget(target: SpaceTargetId | undefined, expected: string): void {
  if (target === undefined) throw new Error("Expected a resolved target");
  expect(target.valueOf()).toBe(expected);
}

describe("newTabTarget", () => {
  test("resolves a named document-backed space to its layout id", () => {
    expectTarget(
      newTabTarget(spaceRow("doc-space", "doc-tab"), layout("doc-space", "doc-tab")),
      "doc-space",
    );
  });

  test("resolves an unnamed document tab by id", () => {
    expectTarget(
      newTabTarget(spaceRow("doc-space", "doc-tab", "Other"), layout("doc-space", "doc-tab", "")),
      "doc-space",
    );
  });

  test("resolves a whitespace-normalized document tab by id", () => {
    expectTarget(
      newTabTarget(
        spaceRow("doc-space", "doc-tab", "Docs"),
        layout("doc-space", "doc-tab", "  Docs "),
      ),
      "doc-space",
    );
  });

  test("resolves a document space with no terminals on this machine", () => {
    expectTarget(
      newTabTarget(spaceRow("doc-space", "doc-tab"), layout("doc-space", "doc-tab", "Docs", [])),
      "doc-space",
    );
  });

  test("does not resolve a synthetic row when a layout is present", () => {
    expect(
      newTabTarget(spaceRow("other", "other-tab", "Other"), layout("doc-space", "doc-tab")),
    ).toBeUndefined();
  });

  test("resolves a label-backed space to the trimmed document id", () => {
    const target = newTabTarget(labelSpace([{ "herdr.space": "sp1" }]), undefined);

    expectTarget(target, "sp1");
    expect(target?.valueOf().startsWith("label-space:")).toBe(false);
  });

  test("trims the shared label before returning it", () => {
    expectTarget(newTabTarget(labelSpace([{ "herdr.space": "  sp1 " }]), undefined), "sp1");
  });

  test("does not resolve an Other row made from unlabelled terminals", () => {
    expect(newTabTarget(labelSpace([{}]), undefined)).toBeUndefined();
  });

  test("does not resolve a row mixing an Other label and an unlabelled terminal", () => {
    expect(newTabTarget(labelSpace([{ "herdr.space": "Other" }, {}]), undefined)).toBeUndefined();
  });

  test("does not resolve a row with no terminals", () => {
    expect(newTabTarget(spaceRow("label-space:sp1", "tab", "sp1"), undefined)).toBeUndefined();
  });

  test("never reads display names from rows or document entries", () => {
    const rowTab = {
      id: "doc-tab",
      get name(): string {
        throw new Error("row tab name must not be read");
      },
      state: "idle" as const,
      terminals: [],
    };
    const row = {
      id: "doc-space",
      get name(): string {
        throw new Error("row name must not be read");
      },
      state: "idle" as const,
      tabs: [rowTab],
    };
    const documentTab = {
      id: "doc-tab",
      get name(): string {
        throw new Error("document tab name must not be read");
      },
      terminalAddresses: [],
    };
    const documentSpace = {
      id: "doc-space",
      get name(): string {
        throw new Error("document space name must not be read");
      },
      folder: null,
      tabs: [documentTab],
    };

    expectTarget(newTabTarget(row, { spaces: [documentSpace] }), "doc-space");
  });
});
