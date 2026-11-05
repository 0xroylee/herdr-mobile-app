/// <reference types="bun" />

import { expect, test } from "bun:test";
import { modalFrameTopInsetClass, pageSheetKeyboardVerticalOffset } from "./modal-frame.ts";

test("omits the window top inset inside iOS page sheets", () => {
  expect(modalFrameTopInsetClass("ios")).toBe("");
});

test("keeps the top inset on Android full-screen modals and web cards", () => {
  expect(modalFrameTopInsetClass("android")).toBe("pt-safe");
  expect(modalFrameTopInsetClass("web")).toBe("pt-safe");
});

test("uses the iOS sheet origin as the keyboard avoidance offset", () => {
  expect(pageSheetKeyboardVerticalOffset("ios", 62)).toBe(62);
});

test("does not apply a page sheet keyboard offset outside iOS", () => {
  expect(pageSheetKeyboardVerticalOffset("android", 62)).toBe(0);
  expect(pageSheetKeyboardVerticalOffset("web", 62)).toBe(0);
});
