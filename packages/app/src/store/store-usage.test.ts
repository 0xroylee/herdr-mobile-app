/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "..");
const directStoreCall = /\b(?:machinesStore|coreStore|settingsStore|seenStore)\s*\(/g;

describe("Zustand store usage", () => {
  test("reads exported stores through useStore instead of calling them directly", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(directStoreCall)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${relative(sourceRoot, file)}:${line}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
