/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
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

  test("unknown programs get a readable name and generic icon", () => {
    expect(getProgram(terminal({ status: { state: "working", app: "my-agent" } }))).toEqual({
      name: "My agent",
      iconKey: "bot",
    });
  });
});
