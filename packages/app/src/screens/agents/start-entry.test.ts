/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { showAgentsStartEntryPoint } from "./start-entry.ts";

describe("Agents Start entry point", () => {
  test("shows it on control devices", () => {
    expect(showAgentsStartEntryPoint("control")).toBe(true);
  });

  test("hides it on watch devices", () => {
    expect(showAgentsStartEntryPoint("watch")).toBe(false);
  });

  test("hides it when there is no paired device", () => {
    expect(showAgentsStartEntryPoint(undefined)).toBe(false);
  });
});
