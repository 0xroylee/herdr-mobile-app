/// <reference types="bun" />

import { expect, test } from "bun:test";
import { modalFrameTopInsetClass, startFrameKeyboardPadding } from "./modal-frame.ts";

test("omits the top inset in iOS page sheets and keeps it on a full-screen start entry", () => {
  expect(modalFrameTopInsetClass("ios")).toBe("");
  expect(modalFrameTopInsetClass("ios", true)).toBe("");
  expect(modalFrameTopInsetClass("ios", false)).toBe("pt-safe");
});

test("keeps the top inset on Android full-screen modals and web cards", () => {
  expect(modalFrameTopInsetClass("android")).toBe("pt-safe");
  expect(modalFrameTopInsetClass("web")).toBe("pt-safe");
});

test("pads the Start frame by the iOS keyboard height when no bottom inset is reserved", () => {
  for (const height of [216, 301, 334, 346]) {
    expect(startFrameKeyboardPadding("ios", height, 0)).toBe(height);
  }
});

test("subtracts the bottom inset already reserved by the Start footer", () => {
  expect(startFrameKeyboardPadding("ios", 216, 34)).toBe(182);
  expect(startFrameKeyboardPadding("ios", 334, 34)).toBe(300);
  expect(startFrameKeyboardPadding("ios", 346, 21)).toBe(325);
});

test("removes Start keyboard padding when the keyboard is hidden", () => {
  expect(startFrameKeyboardPadding("ios", 0, 0)).toBe(0);
  expect(startFrameKeyboardPadding("ios", 0, 34)).toBe(0);
});

test("never returns negative Start keyboard padding", () => {
  expect(startFrameKeyboardPadding("ios", 20, 34)).toBe(0);
  expect(startFrameKeyboardPadding("ios", 34, 34)).toBe(0);
  expect(startFrameKeyboardPadding("ios", -20, 0)).toBe(0);
});

test("does not add Start keyboard padding on Android or web", () => {
  for (const platform of ["android", "web"]) {
    expect(startFrameKeyboardPadding(platform, 334, 0)).toBe(0);
    expect(startFrameKeyboardPadding(platform, 334, 34)).toBe(0);
    expect(startFrameKeyboardPadding(platform, 0, 34)).toBe(0);
  }
});
