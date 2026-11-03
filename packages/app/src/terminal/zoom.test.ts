/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  cellSizeForZoom,
  clampZoom,
  DEFAULT_ZOOM,
  doubleTapZoom,
  gridThatFits,
  MAX_ZOOM,
  MIN_ZOOM,
  overviewZoom,
  readableFitZoom,
  scrollOffsetToBottom,
  zoomFromPinch,
  zoomRangeForGrid,
} from "./zoom.ts";

test("clamps zoom to the kit's 8 to 16 point range", () => {
  expect(clampZoom(4)).toBe(MIN_ZOOM);
  expect(clampZoom(20)).toBe(MAX_ZOOM);
  expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
});

test("scales relative to the starting zoom during a pinch within the active range", () => {
  expect(zoomFromPinch(12, 1.25)).toBe(15);
  expect(zoomFromPinch(12, 2)).toBe(MAX_ZOOM);
  expect(zoomFromPinch(12, 0.25)).toBe(MIN_ZOOM);

  const overviewRange = zoomRangeForGrid(366, 200);
  expect(overviewRange).toEqual({ min: 3.05, max: MAX_ZOOM });
  expect(zoomFromPinch(8, 0.25, overviewRange)).toBe(overviewRange.min);
});

test("uses the kit's default terminal cell size", () => {
  expect(cellSizeForZoom(DEFAULT_ZOOM)).toEqual({
    fontSize: 10.6,
    width: 6.36,
    height: 16.4,
  });
});

test("computes the overview size that fits all columns in the viewport", () => {
  expect(overviewZoom(366, 200)).toBe(3.05);
  expect(overviewZoom(10_000, 200)).toBe(MAX_ZOOM);
  expect(overviewZoom(0, 200)).toBe(MIN_ZOOM);
  expect(zoomRangeForGrid(366, 200)).toEqual({ min: 3.05, max: MAX_ZOOM });
  expect(zoomRangeForGrid(2_000, 100)).toEqual({ min: MIN_ZOOM, max: MAX_ZOOM });
});

test("double-tap switches between overview and default when overview is below default", () => {
  expect(doubleTapZoom(DEFAULT_ZOOM, 366, 200)).toBe(3.05);
  expect(doubleTapZoom(3.02, 366, 200)).toBe(DEFAULT_ZOOM);
  expect(doubleTapZoom(12, 2_000, 100)).toBe(DEFAULT_ZOOM);
});

test("clamps the rendered zoom to a changed range and keeps takeover readable", () => {
  const changedRange = zoomRangeForGrid(366, 100);
  expect(clampZoom(2, changedRange)).toBe(changedRange.min);
  expect(cellSizeForZoom(2, changedRange).fontSize).toBe(changedRange.min);
  expect(readableFitZoom(3.05, zoomRangeForGrid(366, 200))).toBe(MIN_ZOOM);
  expect(readableFitZoom(12, zoomRangeForGrid(366, 200))).toBe(12);
  expect(readableFitZoom(20, zoomRangeForGrid(366, 200))).toBe(MAX_ZOOM);
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
