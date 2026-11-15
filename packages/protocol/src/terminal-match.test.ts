import { describe, expect, test } from "bun:test";
import type { Terminal } from "./generated/hc-api.ts";
import { matchTerminal } from "./terminal-match.ts";

const terminal = (changes: Partial<Terminal> = {}): Terminal => ({
  address: "t1",
  argv: ["claude"],
  cols: 80,
  created_ms: 20_000,
  cwd: "/repo",
  labels: {},
  rows: 24,
  screen: "exact",
  state: "live",
  ...changes,
});

describe("matchTerminal", () => {
  test("requires the program and folder to match exactly", () => {
    const wrongProgram = terminal({ address: "wrong-program", argv: ["codex"] });
    const wrongFolder = terminal({ address: "wrong-folder", cwd: "/other" });
    const matching = terminal({ address: "matching" });

    expect(
      matchTerminal(
        [wrongProgram, wrongFolder, matching],
        { program: "claude", folder: "/repo" },
        20_000,
      ),
    ).toBe(matching);
    expect(
      matchTerminal([matching], { program: "Claude", folder: "/repo" }, 20_000),
    ).toBeUndefined();
    expect(
      matchTerminal([matching], { program: "claude", folder: "/Repo" }, 20_000),
    ).toBeUndefined();
  });

  test("matches the requested Herdr space only when a space id is supplied", () => {
    const otherSpace = terminal({ address: "other-space", labels: { "herdr.space": "sp2" } });
    const matching = terminal({ address: "matching-space", labels: { "herdr.space": "sp1" } });
    const unlabelled = terminal({ address: "unlabelled" });

    expect(
      matchTerminal(
        [otherSpace, matching],
        { program: "claude", folder: "/repo", spaceId: "sp1" },
        20_000,
      ),
    ).toBe(matching);
    expect(matchTerminal([unlabelled], { program: "claude", folder: "/repo" }, 20_000)).toBe(
      unlabelled,
    );
    expect(
      matchTerminal([unlabelled], { program: "claude", folder: "/repo", spaceId: "sp1" }, 20_000),
    ).toBeUndefined();
  });

  test("uses the default 15-second window and accepts its inclusive boundary", () => {
    const atBoundary = terminal({ address: "boundary", created_ms: 5_000 });
    const tooOld = terminal({ address: "old", created_ms: 4_999 });
    const inFuture = terminal({ address: "future", created_ms: 20_001 });

    expect(
      matchTerminal([tooOld, inFuture, atBoundary], { program: "claude", folder: "/repo" }, 20_000),
    ).toBe(atBoundary);
  });

  test("honors a caller-provided time window", () => {
    const within = terminal({ address: "within", created_ms: 19_000 });
    const outside = terminal({ address: "outside", created_ms: 18_999 });

    expect(
      matchTerminal(
        [outside, within],
        { program: "claude", folder: "/repo", withinMs: 1_000 },
        20_000,
      ),
    ).toBe(within);
  });

  test("excludes finished terminals and chooses the newest live match", () => {
    const old = terminal({ address: "old", created_ms: 18_000 });
    const newest = terminal({ address: "newest", created_ms: 19_000 });
    const finished = terminal({ address: "finished", created_ms: 19_500, state: "finished" });

    expect(
      matchTerminal([old, finished, newest], { program: "claude", folder: "/repo" }, 20_000),
    ).toBe(newest);
    expect(
      matchTerminal([finished], { program: "claude", folder: "/repo" }, 20_000),
    ).toBeUndefined();
  });

  test("keeps the first terminal when creation times tie", () => {
    const first = terminal({ address: "first", created_ms: 19_000 });
    const second = terminal({ address: "second", created_ms: 19_000 });

    expect(matchTerminal([first, second], { program: "claude", folder: "/repo" }, 20_000)).toBe(
      first,
    );
  });
});
