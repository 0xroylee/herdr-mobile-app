// @ts-expect-error Bun provides this module at test runtime; Expo's app tsconfig has no Bun types.
import { expect, test } from "bun:test";
import { shortenHomeFolder } from "./folder.ts";

test("shortens an exact supplied home folder", () => {
  expect(shortenHomeFolder("/Users/roy", "/Users/roy")).toBe("~");
});

test("shortens a folder under the supplied home directory", () => {
  expect(shortenHomeFolder("/Users/roy/project", "/Users/roy")).toBe("~/project");
});

test("preserves foreign homes and shared folders", () => {
  expect(shortenHomeFolder("/Users/alice/project", "/Users/roy")).toBe("/Users/alice/project");
  expect(shortenHomeFolder("/Users/Shared/project", "/Users/roy")).toBe("/Users/Shared/project");
});

test("does not shorten a path that only shares the home prefix", () => {
  expect(shortenHomeFolder("/Users/roy2/project", "/Users/roy")).toBe("/Users/roy2/project");
});

test("preserves paths when no home directory is supplied", () => {
  expect(shortenHomeFolder("/Users/roy/project")).toBe("/Users/roy/project");
});
