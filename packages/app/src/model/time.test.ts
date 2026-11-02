/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { formatAge } from "./time.ts";

describe("formatAge", () => {
  const now = 10_000_000;

  test("uses less than a minute below 60 seconds and floors minutes at the boundary", () => {
    expect(formatAge(now - 59_999, now)).toBe("<1m");
    expect(formatAge(now - 60_000, now)).toBe("1m");
    expect(formatAge(now - 4 * 60_000 - 1, now)).toBe("4m");
  });

  test("switches to hours at 60 minutes and days at 24 hours", () => {
    expect(formatAge(now - 60 * 60_000, now)).toBe("1h");
    expect(formatAge(now - 2 * 60 * 60_000, now)).toBe("2h");
    expect(formatAge(now - 24 * 60 * 60_000, now)).toBe("1d");
    expect(formatAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3d");
  });

  test("future or missing timestamps stay under a minute", () => {
    expect(formatAge(now + 30_000, now)).toBe("<1m");
    expect(formatAge(undefined, now)).toBe("<1m");
  });
});
