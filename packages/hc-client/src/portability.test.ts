// hc-client also runs in the Expo app on Hermes. Walk its runtime import graph from index.ts,
// protocol included, and fail on anything that only exists in Node or Bun.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const WORKSPACE: Record<string, string> = {
  "@herdr-mobile/protocol": resolve(repo, "packages/protocol/src/index.ts"),
};
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);
const FORBIDDEN_GLOBALS = [
  "process",
  "Buffer",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "global",
  "TextEncoder",
  "TextDecoder",
  "Bun",
  "Deno",
  "setImmediate",
];
const SPECIFIERS = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']/g,
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
];

/** Drops comments and string contents, so only code is searched for globals and syntax. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
}

export function checkSource(
  file: string,
  source: string,
): { problems: string[]; imports: string[] } {
  const problems: string[] = [];
  const imports: string[] = [];
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) imports.push(match[1] as string);
  }
  for (const spec of imports) {
    const bare = spec.split("/")[0] as string;
    if (
      spec.startsWith("node:") ||
      spec.startsWith("bun:") ||
      spec === "bun" ||
      NODE_BUILTINS.has(bare)
    ) {
      problems.push(`Forbidden runtime import: ${spec}`);
    } else if (spec.startsWith(".") && !spec.endsWith(".ts")) {
      problems.push(`Extensionless relative import: ${spec} in ${file}`);
    } else if (!spec.startsWith(".") && !(spec in WORKSPACE)) {
      problems.push(`Unexpected runtime dependency: ${spec} in ${file}`);
    }
  }
  // Imported names are covered by the import rules above; search the rest for globals.
  const code = codeOnly(
    source.replace(/^\s*(?:import|export)\s[^;]*?from\s*["'][^"']*["'];?/gm, ""),
  );
  for (const name of FORBIDDEN_GLOBALS) {
    if (new RegExp(`(?<![\\w$.])${name}\\b(?!\\s*:)`).test(code)) {
      problems.push(`Forbidden runtime global: ${name} in ${file}`);
    }
  }
  if (/\bimport\.meta\b/.test(code))
    problems.push(`Forbidden runtime global: import.meta in ${file}`);
  const syntax: [RegExp, string][] = [
    [/\benum\s+[A-Za-z_$]/, "enum"],
    [/\bnamespace\s+[A-Za-z_$]/, "namespace"],
    [
      /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+[A-Za-z_$]/,
      "parameter property",
    ],
  ];
  for (const [pattern, name] of syntax) {
    if (pattern.test(code)) problems.push(`Non-erasable syntax: ${name} in ${file}`);
  }
  return { problems, imports };
}

export function checkGraph(entry: string): { problems: string[]; files: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const name = relative(repo, file);
    const result = checkSource(name, readFileSync(file, "utf8"));
    problems.push(...result.problems);
    for (const spec of result.imports) {
      if (spec in WORKSPACE) queue.push(WORKSPACE[spec] as string);
      else if (spec.startsWith(".") && spec.endsWith(".ts"))
        queue.push(resolve(dirname(file), spec));
    }
  }
  return { problems, files: [...seen].map((file) => relative(repo, file)).sort() };
}

describe("portability", () => {
  test("hc-client's runtime import graph uses nothing Node- or Bun-only", () => {
    const { problems, files } = checkGraph(resolve(here, "index.ts"));
    expect(problems).toEqual([]);
    for (const file of ["client.ts", "frame.ts", "lines.ts", "errors.ts", "utf8.ts"]) {
      expect(files).toContain(`packages/hc-client/src/${file}`);
    }
    expect(files).toContain("packages/protocol/src/wire.ts");
    // Tests, test helpers and build tooling never reach the runtime graph.
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(files).not.toContain("packages/hc-client/src/testing.ts");
    expect(files.some((file) => file.includes("/scripts/") || file.includes("fixtures"))).toBe(
      false,
    );
  });

  test("the checker names each kind of problem", () => {
    const source = [
      'import { Buffer } from "node:buffer";',
      'import "./side";',
      'import leftpad from "left-pad";',
      "const env = process.env;",
      "const url = import.meta.url;",
      "enum Mode { A }",
      "class C { constructor(private readonly x: number) {} }",
      '// process in a comment and "Buffer" in a string are fine',
      "const ok = { process: 1 }.process;",
    ].join("\n");
    expect(checkSource("x.ts", source).problems.sort()).toEqual(
      [
        "Forbidden runtime import: node:buffer",
        "Extensionless relative import: ./side in x.ts",
        "Unexpected runtime dependency: left-pad in x.ts",
        "Forbidden runtime global: process in x.ts",
        "Forbidden runtime global: import.meta in x.ts",
        "Non-erasable syntax: enum in x.ts",
        "Non-erasable syntax: parameter property in x.ts",
      ].sort(),
    );
  });
});
