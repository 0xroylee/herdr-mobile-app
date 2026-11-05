/// <reference types="bun" />

import { expect, test } from "bun:test";
import { modalFrameTopInsetClass, pageSheetKeyboardVerticalOffset } from "./modal-frame.ts";

test("omits the top inset in iOS page sheets and keeps it on a full-screen start entry", () => {
  expect(modalFrameTopInsetClass("ios", true)).toBe("");
  expect(modalFrameTopInsetClass("ios", false)).toBe("pt-safe");
});

test("keeps the top inset on Android full-screen modals and web cards", () => {
  expect(modalFrameTopInsetClass("android")).toBe("pt-safe");
  expect(modalFrameTopInsetClass("web")).toBe("pt-safe");
});

test("converts the Start frame to window coordinates for different sheet origins", () => {
  const windowHeight = 874;
  const keyboardTop = 540;
  const frameLocalY = 12;

  for (const sheetOrigin of [0, 62, 72]) {
    const frameWindowY = sheetOrigin + frameLocalY;
    const frameHeight = windowHeight - frameWindowY;
    const offset = pageSheetKeyboardVerticalOffset("ios", frameLocalY, frameWindowY);
    const keyboardAvoidance = Math.max(frameLocalY + frameHeight - (keyboardTop - offset), 0);
    const neededAvoidance = Math.max(frameWindowY + frameHeight - keyboardTop, 0);

    expect(keyboardAvoidance).toBe(neededAvoidance);
  }
});

test("does not apply a page sheet keyboard offset outside iOS", () => {
  expect(pageSheetKeyboardVerticalOffset("android", 12, 74)).toBe(0);
  expect(pageSheetKeyboardVerticalOffset("web", 12, 74)).toBe(0);
});
