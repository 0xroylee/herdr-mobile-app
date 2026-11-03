/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  beginTerminalDrag,
  createTerminalFollowState,
  endTerminalDrag,
  observeScrollOffset,
  PROGRAMMATIC_SCROLL_TOLERANCE,
  setAutomaticScrollTarget,
  setFollowGeometry,
  setProgrammaticScrollOffset,
} from "./follow-state.ts";

function automaticTarget(state: ReturnType<typeof createTerminalFollowState>, offset: number) {
  const transition = setAutomaticScrollTarget(state, offset, 10);
  return transition.shouldScroll
    ? setProgrammaticScrollOffset(transition.state, offset)
    : transition.state;
}

test("follows the automatic target as output advances", () => {
  let state = createTerminalFollowState();
  state = automaticTarget(state, 20);
  state = observeScrollOffset(state, 20);
  const nextTarget = setAutomaticScrollTarget(state, 30, 10);

  expect(nextTarget.shouldScroll).toBe(true);
  expect(nextTarget.state.automaticOffset).toBe(30);
});

test("a user scrolling away pauses following while later output advances", () => {
  let state = automaticTarget(createTerminalFollowState(), 60);
  state = observeScrollOffset(state, 60);
  state = observeScrollOffset(state, 20);
  const nextTarget = setAutomaticScrollTarget(state, 70, 10);

  expect(state.followsFocus).toBe(false);
  expect(nextTarget.shouldScroll).toBe(false);
});

test("observing a return within one cell of focus resumes following", () => {
  let state = automaticTarget(createTerminalFollowState(), 60);
  state = observeScrollOffset(state, 60);
  state = observeScrollOffset(state, 20);
  state = setAutomaticScrollTarget(state, 40, 10).state;
  state = observeScrollOffset(state, 49);
  const nextTarget = setAutomaticScrollTarget(state, 50, 10);

  expect(state.followsFocus).toBe(true);
  expect(nextTarget.shouldScroll).toBe(true);
});

test("the grid's scrollTo event does not pause following", () => {
  let state = createTerminalFollowState();
  const target = setAutomaticScrollTarget(state, 24, 10);
  state = setProgrammaticScrollOffset(target.state, 24);
  state = observeScrollOffset(state, 24 + PROGRAMMATIC_SCROLL_TOLERANCE / 2);

  expect(state.followsFocus).toBe(true);
  expect(state.pendingProgrammaticOffsets).toHaveLength(0);
});

test("a geometry change resumes following and ignores a clamped offset", () => {
  let state = automaticTarget(createTerminalFollowState(), 80);
  state = observeScrollOffset(state, 80);
  state = beginTerminalDrag(state);
  state = observeScrollOffset(state, 75);
  const geometry = setFollowGeometry(state, {
    offset: 10,
    cellHeight: 10,
    maxOffset: 30,
  });

  state = setProgrammaticScrollOffset(geometry.state, 10);
  state = observeScrollOffset(state, 30);
  expect(state.followsFocus).toBe(true);
  expect(state.clampedOffset).toBe(null);

  state = observeScrollOffset(state, 10);
  expect(geometry.shouldScroll).toBe(true);
  expect(state.followsFocus).toBe(true);
  expect(state.pendingProgrammaticOffsets).toHaveLength(0);
});

test("the initial browser offset after layout is not treated as a user scroll", () => {
  const geometry = setFollowGeometry(createTerminalFollowState(), {
    offset: 40,
    cellHeight: 10,
    maxOffset: 100,
  });
  const state = observeScrollOffset(geometry.state, 0);

  expect(geometry.shouldScroll).toBe(true);
  expect(state.followsFocus).toBe(true);
  expect(state.clampedOffset).toBe(null);
});

test("native drag events preserve the existing return-to-focus behavior", () => {
  let state = automaticTarget(createTerminalFollowState(), 50);
  state = beginTerminalDrag(state);
  state = observeScrollOffset(state, 20);
  state = endTerminalDrag(state, 49);

  expect(state.followsFocus).toBe(true);
});
