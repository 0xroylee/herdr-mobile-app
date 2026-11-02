/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  cellSizeForZoom,
  clampZoom,
  DEFAULT_ZOOM,
  gridThatFits,
  MAX_ZOOM,
  MIN_ZOOM,
  resetZoom,
  scrollOffsetToBottom,
  zoomFromPinch,
} from "./zoom.ts";

test("clamps zoom to the kit's 8 to 16 point range", () => {
  expect(clampZoom(4)).toBe(MIN_ZOOM);
  expect(clampZoom(20)).toBe(MAX_ZOOM);
  expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
});

test("scales relative to the starting zoom during a pinch", () => {
  expect(zoomFromPinch(12, 1.25)).toBe(15);
  expect(zoomFromPinch(12, 2)).toBe(MAX_ZOOM);
  expect(zoomFromPinch(12, 0.25)).toBe(MIN_ZOOM);
});

test("uses the kit's default terminal cell size and resets to its default zoom", () => {
  expect(cellSizeForZoom(DEFAULT_ZOOM)).toEqual({
    fontSize: 10.6,
    width: 6.36,
    height: 16.4,
  });
  expect(resetZoom()).toBe(DEFAULT_ZOOM);
});

test("fits the grid to the viewport at the displayed zoom", () => {
  const viewport = { width: 366, height: 480 };

  expect(gridThatFits(viewport, DEFAULT_ZOOM)).toEqual({ cols: 57, rows: 29 });
  expect(gridThatFits(viewport, 16)).toEqual({ cols: 38, rows: 19 });
  expect(gridThatFits(viewport, 8)).toEqual({ cols: 76, rows: 38 });
  expect(gridThatFits({ width: 0, height: 0 }, DEFAULT_ZOOM)).toEqual({ cols: 0, rows: 0 });
});

test("calculates the vertical offset that aligns content to the bottom", () => {
  expect(scrollOffsetToBottom(600, 300)).toBe(300);
  expect(scrollOffsetToBottom(300, 600)).toBe(0);
  expect(scrollOffsetToBottom(300, 300)).toBe(0);
});
