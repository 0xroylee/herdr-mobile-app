// Walk secure-channel's runtime graph, including its hc-client dependency, and
// fail on anything that only exists in Node or Bun.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const WORKSPACE: Record<string, string> = {
  "@herdr-mobile/hc-client": resolve(repo, "packages/hc-client/src/index.ts"),
  "@herdr-mobile/protocol": resolve(repo, "packages/protocol/src/index.ts"),
};
const PORTABLE_DEPENDENCIES = ["@noble/ciphers", "@noble/curves", "@noble/hashes"];
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
    } else if (
      !spec.startsWith(".") &&
      !(spec in WORKSPACE) &&
      !PORTABLE_DEPENDENCIES.some(
        (dependency) => spec === dependency || spec.startsWith(`${dependency}/`),
      )
    ) {
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
  test("secure-channel and hc-client runtime graphs use nothing Node- or Bun-only", () => {
    const { problems, files } = checkGraph(resolve(here, "index.ts"));
    expect(problems).toEqual([]);
    const runtimeSources = files
      .map((file) => readFileSync(resolve(repo, file), "utf8"))
      .join("\n");
    expect(runtimeSources).not.toContain("@noble/curves/ed25519.js");
    expect(files).toContain("packages/hc-client/src/index.ts");
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

  test("cold-imports and exchanges protected records without text codecs", () => {
    const entry = new URL("./index.ts", import.meta.url).href;
    const script = `
      delete globalThis.TextEncoder;
      delete globalThis.TextDecoder;
      const { createMemoryDuplexPair, generateStaticKeyPair, openInitiator, openResponder } =
        await import(${JSON.stringify(entry)});
      const [initiatorSocket, responderSocket] = createMemoryDuplexPair();
      const staticKey = generateStaticKeyPair();
      const responderOpening = openResponder(responderSocket, { localStatic: staticKey });
      const initiatorOpening = openInitiator(initiatorSocket, { remoteStaticKey: staticKey.publicKey });
      const [initiator, responder] = await Promise.all([initiatorOpening, responderOpening]);
      let receivedText;
      let receivedBinary;
      responder.onRecord((kind, data) => {
        if (kind === "text") receivedText = data;
      });
      initiator.onRecord((kind, data) => {
        if (kind === "binary") receivedBinary = data;
      });
      initiator.send("text", new Uint8Array([104, 105]));
      responder.send("binary", new Uint8Array([0, 1, 254, 255]));
      if (String(receivedText) !== "104,105") throw new Error("text record exchange failed");
      if (String(receivedBinary) !== "0,1,254,255") throw new Error("binary record exchange failed");
      initiator.close(1000, "test complete");
      await Promise.all([initiator.closed, responder.closed]);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0);
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
