/// <reference types="bun" />
import { expect, test } from "bun:test";
import { coalesceRuns, type ScreenSnapshot, screenTextRows } from "./snapshot.ts";

const defaultColor = { kind: "default" } as const;
const red = { kind: "ansi", index: 1 } as const;

test("coalesces adjacent cells that share every style field", () => {
  expect(
    coalesceRuns([
      { text: "a", fg: red, bg: defaultColor, bold: false, inverse: false },
      { text: "b", fg: red, bg: defaultColor, bold: false, inverse: false },
      { text: "c", fg: red, bg: defaultColor, bold: true, inverse: false },
      { text: "", fg: red, bg: defaultColor, bold: true, inverse: false },
    ]),
  ).toEqual([
    { text: "ab", fg: red, bg: defaultColor, bold: false, inverse: false },
    { text: "c", fg: red, bg: defaultColor, bold: true, inverse: false },
  ]);
});

test("provides top-first plain text rows and trims terminal padding", () => {
  const snapshot: ScreenSnapshot = {
    cols: 8,
    rows: [
      [{ text: "hello   ", fg: defaultColor, bg: defaultColor, bold: false, inverse: false }],
      [{ text: "next", fg: red, bg: defaultColor, bold: false, inverse: false }],
    ],
    cursor: { x: 4, y: 1, visible: true },
  };

  expect(screenTextRows(snapshot)).toEqual(["hello", "next"]);
});
