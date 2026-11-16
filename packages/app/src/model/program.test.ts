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
});
