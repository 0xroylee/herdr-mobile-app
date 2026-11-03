/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  focusRowForSnapshot,
  preserveTerminalSpaces,
  scrollOffsetToFocusRow,
} from "./grid-layout.ts";
import { defaultTerminalColor, type ScreenSnapshot } from "./snapshot.ts";

function run(text: string) {
  return {
    text,
    fg: defaultTerminalColor,
    bg: defaultTerminalColor,
    bold: false,
    inverse: false,
  };
}

function snapshot(rows: string[], cursorY = 0, cursorVisible = false): ScreenSnapshot {
  return {
    cols: 10,
    rows: rows.map((text) => (text.length === 0 ? [] : [run(text)])),
    cursor: { x: 0, y: cursorY, visible: cursorVisible },
  };
}

test("preserves leading spaces and runs of spaces for terminal rows", () => {
  expect(preserveTerminalSpaces("  cd  /tmp ")).toBe("\u00a0\u00a0cd\u00a0\u00a0/tmp\u00a0");
});

test("focuses the later of the last non-space row and a visible cursor row", () => {
  const current = snapshot(["first", "   ", "last", ""], 3, true);
  expect(focusRowForSnapshot(current)).toBe(3);

  const cursorHidden = snapshot(["first", "   ", "last", ""], 3, false);
  expect(focusRowForSnapshot(cursorHidden)).toBe(2);
});

test("uses the final grid row when there is no text or visible cursor", () => {
  expect(focusRowForSnapshot(snapshot(["", "   ", ""], 0, false))).toBe(2);
  expect(focusRowForSnapshot(snapshot([]))).toBe(0);
});

test("aligns the focus row bottom with the viewport and clamps to the scroll range", () => {
  expect(
    scrollOffsetToFocusRow({
      focusRow: 4,
      cellHeight: 10,
      viewportHeight: 25,
      contentHeight: 100,
      gridOffset: 0,
    }),
  ).toBe(25);
  expect(
    scrollOffsetToFocusRow({
      focusRow: 0,
      cellHeight: 10,
      viewportHeight: 25,
      contentHeight: 100,
      gridOffset: 0,
    }),
  ).toBe(0);
  expect(
    scrollOffsetToFocusRow({
      focusRow: 20,
      cellHeight: 10,
      viewportHeight: 25,
      contentHeight: 100,
      gridOffset: 0,
    }),
  ).toBe(75);
});

test("keeps short grids bottom-aligned without scrolling", () => {
  expect(
    scrollOffsetToFocusRow({
      focusRow: 2,
      cellHeight: 10,
      viewportHeight: 50,
      contentHeight: 50,
      gridOffset: 20,
    }),
  ).toBe(0);
});
