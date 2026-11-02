import type { JsonValue } from "./wire.ts";

/** Two ordered spaces and a nested tab tree based on the researched app shape. */
export const validHerdrAppDoc: JsonValue = {
  spaces: [
    {
      id: "sp-first",
      name: "",
      folder: null,
      tabs: [
        {
          id: "tb-shells",
          name: "",
          root: {
            type: "row",
            id: "row-1",
            children: [
              {
                type: "block",
                id: "p1",
                content: { terminal: "t1" },
              },
              {
                type: "column",
                id: "column-1",
                children: [
                  {
                    type: "block",
                    id: "p2",
                    content: { terminal: "box/t2" },
                  },
                ],
              },
            ],
          },
        },
        {
          id: "tb-next",
          name: "Codex",
          root: {
            type: "block",
            id: "p3",
            content: { terminal: "t3" },
          },
        },
      ],
    },
    {
      id: "sp-second",
      name: "Research",
      folder: "Work",
      tabs: [
        {
          id: "tb-research",
          name: "Notes",
          root: {
            type: "row",
            id: "row-2",
            children: [
              {
                type: "block",
                id: "p4",
                content: { terminal: "t4" },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** Mixed leaves exercise ordered collection and isolation of malformed layout nodes. */
export const mixedLeafHerdrAppDoc: JsonValue = {
  spaces: [
    {
      id: "sp-mixed",
      name: "Mixed leaves",
      folder: null,
      tabs: [
        {
          id: "tb-mixed",
          name: "Sibling leaf",
          root: {
            type: "row",
            id: "row-mixed",
            children: [
              { type: "block", id: "p-before", content: { terminal: "t-before" } },
              { type: "block", id: "p-empty", content: {} },
            ],
          },
        },
        {
          id: "tb-nested",
          name: "Nested leaf",
          root: {
            type: "row",
            id: "row-nested",
            children: [
              { type: "block", id: "p-root-before", content: { terminal: "t-root-before" } },
              {
                type: "column",
                id: "column-nested",
                children: [
                  {
                    type: "block",
                    id: "p-column-before",
                    content: { terminal: "t-column-before" },
                  },
                  { type: "block", id: "p-column-empty", content: {} },
                  { type: "block", id: "p-column-after", content: { terminal: "t-column-after" } },
                ],
              },
              { type: "block", id: "p-root-after", content: { terminal: "t-root-after" } },
            ],
          },
        },
        {
          id: "tb-unreadable",
          name: "Unreadable nodes",
          root: {
            type: "row",
            id: "row-unreadable",
            children: [
              { type: "block", id: "p-left", content: { terminal: "t-left" } },
              {
                type: "row",
                children: [{ type: "block", id: "p-hidden", content: { terminal: "t-hidden" } }],
              },
              null,
              7,
              { type: "column", id: "column-no-children" },
              { type: "block", id: "p-middle", content: { terminal: "t-middle" } },
              { type: "block", content: { terminal: "t-no-id" } },
              { type: "block", id: "p-right", content: { terminal: "t-right" } },
            ],
          },
        },
        {
          id: "tb-empty",
          name: "No terminal",
          root: { type: "block", id: "p-empty-only", content: {} },
        },
      ],
    },
  ],
};

/**
 * Inputs that exercise malformed roots, spaces, and top-level values. A bad
 * leaf keeps its tab with no addresses; a tab without an object root is skipped.
 */
export const malformedHerdrAppDocVariants: JsonValue[] = [
  null,
  false,
  [],
  {},
  { spaces: [null, 7, { id: "sp-bad", name: "No tabs", folder: null }] },
  {
    spaces: [
      {
        id: "sp-good",
        name: "Good",
        folder: null,
        tabs: [
          { id: "tb-no-root", name: "Missing root" },
          {
            id: "tb-bad-leaf",
            name: "Bad leaf",
            root: { type: "block", id: "p1", content: {} },
          },
          {
            id: "tb-good",
            name: "Good tab",
            root: {
              type: "block",
              id: "p2",
              content: { terminal: "t2" },
            },
          },
          42,
        ],
      },
      { id: "sp-no-folder", name: "Bad space", tabs: [] },
    ],
  },
];
