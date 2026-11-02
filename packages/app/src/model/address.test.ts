/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { machinePrefix, splitAddress } from "./address.ts";

describe("terminal addresses", () => {
  test("local addresses have no machine prefix", () => {
    expect(splitAddress("t7")).toEqual({ machine: undefined, terminal: "t7" });
    expect(machinePrefix("t7")).toBeUndefined();
  });

  test("remote addresses split at the first slash", () => {
    expect(splitAddress("rohan/t7")).toEqual({ machine: "rohan", terminal: "t7" });
    expect(splitAddress("outer/inner/t7")).toEqual({ machine: "outer", terminal: "inner/t7" });
    expect(machinePrefix("rohan/t7")).toBe("rohan");
  });

  test("malformed prefixes stay local", () => {
    expect(splitAddress("/t7")).toEqual({ machine: undefined, terminal: "/t7" });
    expect(splitAddress("rohan/")).toEqual({ machine: undefined, terminal: "rohan/" });
  });
});
