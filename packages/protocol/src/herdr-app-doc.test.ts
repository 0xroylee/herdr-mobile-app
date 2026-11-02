import { describe, expect, it } from "bun:test";
import {
  malformedHerdrAppDocVariants,
  mixedLeafHerdrAppDoc,
  validHerdrAppDoc,
} from "./herdr-app-doc.fixtures.ts";
import { parseHerdrAppDoc } from "./herdr-app-doc.ts";
import type { JsonValue } from "./wire.ts";

describe("parseHerdrAppDoc", () => {
  it("keeps space, tab, and block order while extracting only the known fields", () => {
    expect(parseHerdrAppDoc(validHerdrAppDoc)).toEqual({
      spaces: [
        {
          id: "sp-first",
          name: "",
          folder: null,
          tabs: [
            { id: "tb-shells", name: "", terminalAddresses: ["t1", "box/t2"] },
            { id: "tb-next", name: "Codex", terminalAddresses: ["t3"] },
          ],
        },
        {
          id: "sp-second",
          name: "Research",
          folder: "Work",
          tabs: [{ id: "tb-research", name: "Notes", terminalAddresses: ["t4"] }],
        },
      ],
    });
  });

  it("returns undefined when the top-level value has no spaces array", () => {
    for (const value of malformedHerdrAppDocVariants.slice(0, 4)) {
      expect(parseHerdrAppDoc(value)).toBeUndefined();
    }
  });

  it("skips malformed spaces and tabs without losing valid siblings", () => {
    const parsed = parseHerdrAppDoc(malformedHerdrAppDocVariants[5] ?? null);
    expect(parsed).toEqual({
      spaces: [
        {
          id: "sp-good",
          name: "Good",
          folder: null,
          tabs: [
            { id: "tb-bad-leaf", name: "Bad leaf", terminalAddresses: [] },
            { id: "tb-good", name: "Good tab", terminalAddresses: ["t2"] },
          ],
        },
      ],
    });
  });

  it("keeps a terminal when a later block leaf has no terminal", () => {
    expect(findMixedTab("tb-mixed")).toEqual({
      id: "tb-mixed",
      name: "Sibling leaf",
      terminalAddresses: ["t-before"],
    });
  });

  it("collects terminals around a nested nonterminal leaf in document order", () => {
    expect(findMixedTab("tb-nested")).toEqual({
      id: "tb-nested",
      name: "Nested leaf",
      terminalAddresses: ["t-root-before", "t-column-before", "t-column-after", "t-root-after"],
    });
  });

  it("skips unreadable nodes while keeping readable siblings in order", () => {
    expect(findMixedTab("tb-unreadable")).toEqual({
      id: "tb-unreadable",
      name: "Unreadable nodes",
      terminalAddresses: ["t-left", "t-middle", "t-right"],
    });
  });

  it("keeps a tab whose only leaf has no terminal with an empty address list", () => {
    expect(findMixedTab("tb-empty")).toEqual({
      id: "tb-empty",
      name: "No terminal",
      terminalAddresses: [],
    });
  });

  it("collects terminals from 100,000 nested containers without recursion", () => {
    let chain: JsonValue = { type: "block", id: "p-deep", content: { terminal: "t-deep" } };
    for (let depth = 0; depth < 100_000; depth += 1) {
      chain = { type: "row", id: `row-${depth}`, children: [chain] };
    }

    const parsed = parseHerdrAppDoc({
      spaces: [
        {
          id: "sp-deep",
          name: "Deep",
          folder: null,
          tabs: [
            {
              id: "tb-deep",
              name: "Deep tree",
              root: {
                type: "row",
                id: "row-root",
                children: [
                  chain,
                  { type: "block", id: "p-after", content: { terminal: "t-after" } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed?.spaces[0]?.tabs).toEqual([
      { id: "tb-deep", name: "Deep tree", terminalAddresses: ["t-deep", "t-after"] },
    ]);
  });

  it("returns an empty layout when all space entries are malformed", () => {
    expect(parseHerdrAppDoc(malformedHerdrAppDocVariants[3] ?? null)).toBeUndefined();
    expect(parseHerdrAppDoc({ spaces: [null, 4, { id: "bad", name: "Bad" }] })).toEqual({
      spaces: [],
    });
  });
});

function findMixedTab(tabId: string) {
  return parseHerdrAppDoc(mixedLeafHerdrAppDoc)?.spaces[0]?.tabs.find(({ id }) => id === tabId);
}
