/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { showSpaceStartEntryPoint } from "./start-entry.ts";

describe("Space Start entry point", () => {
  test("shows it on control devices", () => {
    expect(showSpaceStartEntryPoint("control")).toBe(true);
  });

  test("hides it on watch devices", () => {
    expect(showSpaceStartEntryPoint("watch")).toBe(false);
  });

  test("hides it when there is no paired device", () => {
    expect(showSpaceStartEntryPoint(undefined)).toBe(false);
  });
});
