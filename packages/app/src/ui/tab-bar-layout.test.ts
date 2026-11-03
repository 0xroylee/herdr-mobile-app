/// <reference types="bun" />

import { expect, test } from "bun:test";
import { calculateTabBarLayout } from "./tab-bar-layout.ts";

const borderAtThreeDpr = 2 / 3;

test("sizes the native tab bar at font scale 1", () => {
  expect(calculateTabBarLayout(1, 0, borderAtThreeDpr)).toEqual({
    height: 51,
    labelLineHeight: 13,
  });
});

test("budgets the accessibility-scaled label once at font scale 3.1", () => {
  expect(calculateTabBarLayout(3.1, 0, borderAtThreeDpr)).toEqual({
    height: 78,
    labelLineHeight: 13,
  });
});

test("adds the bottom inset after sizing the tab content", () => {
  expect(calculateTabBarLayout(1, 34, borderAtThreeDpr)).toEqual({
    height: 85,
    labelLineHeight: 13,
  });
  expect(calculateTabBarLayout(3.1, 34, borderAtThreeDpr)).toEqual({
    height: 112,
    labelLineHeight: 13,
  });
});
