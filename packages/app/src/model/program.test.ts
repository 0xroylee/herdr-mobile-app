/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import { deriveAgents } from "./agents.ts";
import { getProgram } from "./program.ts";

const terminal = (changes: Partial<Terminal> = {}): Terminal => ({
  address: "t1",
  argv: ["/bin/zsh"],
  cols: 80,
  created_ms: 1,
  cwd: "/repo",
  labels: {},
  rows: 24,
  screen: "exact",
  state: "live",
  ...changes,
});

describe("program info", () => {
  test("uses the reported app and maps known icon keys", () => {
    expect(getProgram(terminal({ status: { state: "working", app: "Claude Code" } }))).toEqual({
      name: "Claude Code",
      iconKey: "claude",
    });
    expect(getProgram(terminal({ status: { state: "blocked", app: "codex" } }))).toEqual({
      name: "Codex",
      iconKey: "codex",
    });
  });

  test("falls back to foreground name, then foreground argv, then terminal argv", () => {
    expect(
      getProgram(terminal({ foreground: { pid: 2, name: "claude", argv: ["claude"], cwd: "/" } })),
    ).toEqual({
      name: "Claude Code",
      iconKey: "claude",
    });
    expect(
      getProgram(
        terminal({ foreground: { pid: 2, name: "", argv: ["/usr/bin/codex"], cwd: "/" } }),
      ),
    ).toEqual({
      name: "Codex",
      iconKey: "codex",
    });
    expect(getProgram(terminal({ argv: ["/usr/bin/git"] }))).toEqual({
      name: "Git",
      iconKey: "bot",
    });
  });

  test("recognizes Claude Code and Codex launched through JavaScript runtimes", () => {
    for (const [runtime, args, expected] of [
      ["node", ["/opt/homebrew/bin/claude"], "Claude Code"],
      ["node", ["/usr/local/bin/claude.js"], "Claude Code"],
      ["node", ["/x/node_modules/@anthropic-ai/claude-code/cli.js"], "Claude Code"],
      ["bun", ["/x/codex.js"], "Codex"],
      ["bun", ["run", "/x/claude"], "Claude Code"],
      ["bun", ["/opt/claude.mjs"], "Claude Code"],
      ["bun", ["run", "/opt/claude.mjs"], "Claude Code"],
      ["deno", ["/x/codex.js"], "Codex"],
      ["deno", ["run", "/x/codex.js"], "Codex"],
      ["deno", ["run", "/opt/codex.cjs"], "Codex"],
      ["node", ["/repo/node_modules/@anthropic-ai/claude-code/cli.js"], "Claude Code"],
      ["bun", ["run", "/repo/node_modules/@openai/codex/bin/codex.js"], "Codex"],
    ] as const) {
      expect(
        getProgram(
          terminal({
            foreground: { pid: 2, name: runtime, argv: [runtime, ...args], cwd: "/repo" },
          }),
        ),
      ).toEqual({ name: expected, iconKey: expected === "Claude Code" ? "claude" : "codex" });
    }

    expect(
      getProgram(
        terminal({
          foreground: {
            pid: 2,
            name: "",
            argv: ["/usr/local/bin/node", "/opt/claude.cjs"],
            cwd: "/repo",
          },
        }),
      ),
    ).toEqual({ name: "Claude Code", iconKey: "claude" });
  });

  test("does not parse runtime options before an agent entry script", () => {
    const cases = [
      ["node", ["node", "--no-warnings", "/x/claude"], "Node"],
      ["node", ["node", "--", "/x/claude"], "Node"],
      ["bun", ["bun", "run", "--", "/x/claude"], "Bun"],
      ["deno", ["deno", "run", "--allow-all", "/x/codex.js"], "Deno"],
      ["deno", ["deno", "run", "--unsafely-ignore-certificate-errors", "/x/claude"], "Deno"],
      [
        "deno",
        ["deno", "run", "--unsafely-ignore-certificate-errors=localhost", "/x/codex.js"],
        "Deno",
      ],
      [
        "node",
        [
          "node",
          "-r",
          "/tmp/preload.js",
          "--import",
          "/tmp/import.js",
          "--experimental-default-type",
          "module",
          "--trace-warnings",
          "/usr/local/bin/claude.js",
          "/tmp/codex.js",
        ],
        "Node",
      ],
      [
        "bun",
        [
          "bun",
          "--config",
          "/repo/bunfig.toml",
          "run",
          "--preload",
          "/tmp/preload.js",
          "/opt/codex.cjs",
          "claude",
        ],
        "Bun",
      ],
      [
        "deno",
        [
          "deno",
          "--config",
          "/repo/deno.json",
          "run",
          "--config",
          "/repo/run.json",
          "/opt/claude.mjs",
          "codex",
        ],
        "Deno",
      ],
    ] as const;

    for (const [runtime, argv, expected] of cases) {
      expect(
        getProgram(
          terminal({
            foreground: { pid: 2, name: runtime, argv: [...argv], cwd: "/repo" },
          }),
        ),
      ).toEqual({ name: expected, iconKey: "bot" });
    }
  });

  test("does not match application arguments, option values, eval text, or preload modules", () => {
    const cases = [
      ["node", ["node", "/tmp/report.js", "claude"], "Node"],
      ["bun", ["bun", "run", "/tmp/report.ts", "--out", "/tmp/codex.js"], "Bun"],
      ["deno", ["deno", "run", "/tmp/report.ts", "claude"], "Deno"],
      ["node", ["node", "--require", "/tmp/claude.js", "/tmp/report.js"], "Node"],
      ["node", ["node", "--require", "--eval", "claude.js"], "Node"],
      ["bun", ["bun", "--config", "/tmp/codex.js", "run", "/tmp/report.ts"], "Bun"],
      ["deno", ["deno", "run", "--config", "/tmp/codex.js", "/tmp/report.ts"], "Deno"],
      ["node", ["node", "--eval", "require('claude')"], "Node"],
      ["node", ["node", "-e", "claude"], "Node"],
      ["node", ["node", "-p", "'codex'"], "Node"],
      ["node", ["node", "--preload", "/tmp/codex.js", "/tmp/report.js"], "Node"],
      ["bun", ["bun", "--preload", "/tmp/claude.js", "run", "/tmp/report.ts"], "Bun"],
      ["bun", ["bun", "--preload", "/x/claude.js", "/tmp/a.js"], "Bun"],
      ["node", ["node", "--unknown-runtime-option", "/tmp/claude.js"], "Node"],
      ["node", ["zsh", "/tmp/claude.js"], "Node"],
      ["deno", ["deno", "eval", "'claude()'"], "Deno"],
    ] as const;

    for (const [runtime, argv, expected] of cases) {
      expect(
        getProgram(
          terminal({
            foreground: { pid: 2, name: runtime, argv: [...argv], cwd: "/repo" },
          }),
        ),
      ).toEqual({ name: expected, iconKey: "bot" });
    }
  });

  test("skips only an immediate run argument for Bun and Deno", () => {
    for (const [runtime, argv, expected] of [
      ["node", ["node", "run", "/x/claude"], "Node"],
      ["bun", ["bun", "Run", "/x/claude"], "Bun"],
      ["bun", ["bun", "run", "run", "/x/claude"], "Bun"],
      ["deno", ["deno", "RUN", "/x/codex.js"], "Deno"],
      ["deno", ["deno", "run", "run", "/x/codex.js"], "Deno"],
    ] as const) {
      expect(
        getProgram(
          terminal({
            foreground: { pid: 2, name: runtime, argv: [...argv], cwd: "/repo" },
          }),
        ),
      ).toEqual({ name: expected, iconKey: "bot" });
    }
  });

  test("leaves runtimes without a script unknown", () => {
    for (const [runtime, argv, expected] of [
      ["node", [], "Node"],
      ["node", ["node"], "Node"],
      ["bun", ["bun"], "Bun"],
      ["bun", ["bun", "run"], "Bun"],
      ["deno", ["deno"], "Deno"],
      ["deno", ["deno", "run"], "Deno"],
    ] as const) {
      expect(
        getProgram(
          terminal({
            foreground: { pid: 2, name: runtime, argv: [...argv], cwd: "/repo" },
          }),
        ),
      ).toEqual({ name: expected, iconKey: "bot" });
    }
  });

  test("does not turn a Deno script argument into a program or pending agent", () => {
    const unrelatedTerminal = terminal({
      foreground: {
        pid: 2,
        name: "deno",
        argv: ["deno", "run", "--unsafely-ignore-certificate-errors", "/tmp/report.ts", "claude"],
        cwd: "/repo",
      },
      reported: false,
      status: null,
    });

    expect(getProgram(unrelatedTerminal)).toEqual({ name: "Deno", iconKey: "bot" });
    expect(
      deriveAgents([unrelatedTerminal], undefined, {}, "machine-id", 20, "priority", undefined),
    ).toEqual([]);
  });

  test("lists a runtime-launched Claude Code terminal as a pending agent", () => {
    const rows = deriveAgents(
      [
        terminal({
          address: "runtime-claude",
          argv: ["zsh"],
          foreground: {
            pid: 2,
            name: "node",
            argv: ["node", "/repo/node_modules/@anthropic-ai/claude-code/cli.js"],
            cwd: "/repo",
          },
          reported: false,
          status: null,
        }),
      ],
      undefined,
      {},
      "machine-id",
      20,
      "priority",
      undefined,
    );

    expect(rows.map(({ label }) => label)).toEqual(["Idle"]);
    expect(rows[0]?.agents[0]).toMatchObject({
      program: { name: "Claude Code" },
      state: "idle",
      pending: true,
    });
  });

  test("unknown programs get a readable name and generic icon", () => {
    expect(getProgram(terminal({ status: { state: "working", app: "my-agent" } }))).toEqual({
      name: "My agent",
      iconKey: "bot",
    });
  });
});
