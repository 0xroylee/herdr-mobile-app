/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  claudeChromeOnlyScreen,
  claudeDoneScreen,
  claudeWrappedComposerScreen,
  codexChromeOnlyScreen,
  codexDoneScreen,
  codexWorkingTreeScreen,
  codexWrappedComposerScreen,
  emptyDoneScreen,
} from "./summary/fixtures.ts";
import { summarize } from "./summary.ts";

describe("task summaries", () => {
  test("extracts the last response paragraph from Claude Code rows", () => {
    expect(summarize("claude", undefined, claudeDoneScreen)).toBe(
      "All 27 focused tests pass, and workspace typecheck is clean.",
    );
  });

  test("extracts the last response paragraph from Codex rows", () => {
    expect(summarize("codex", undefined, codexDoneScreen)).toBe(
      "The focused model tests pass, with no protocol changes needed.",
    );
  });

  test("keeps Codex answers that begin with an activity word", () => {
    expect(summarize("codex", undefined, codexWorkingTreeScreen)).toBe("Working tree is clean.");
  });

  test("prefers status.msg and turns it into one line capped at 160 characters", () => {
    expect(summarize("claude", { state: "done", msg: "  First line\nsecond\tline  " }, [])).toBe(
      "First line second line",
    );
    const long = summarize("codex", { state: "done", msg: "x".repeat(200) }, []);
    expect(long).toHaveLength(160);
    expect(long?.endsWith("…")).toBe(true);
    const unicode = summarize("claude", { state: "done", msg: "😀".repeat(161) }, []);
    expect(Array.from(unicode ?? "")).toHaveLength(160);
    expect(unicode?.endsWith("…")).toBe(true);
  });

  test("uses the generic last nonblank, nonborder line for other programs", () => {
    expect(
      summarize("terminal", undefined, ["Earlier answer", "", "│ Latest output │", "────────"]),
    ).toBe("Latest output");
  });

  test("returns undefined when the screen has no summary text", () => {
    expect(summarize("claude", undefined, emptyDoneScreen)).toBeUndefined();
    expect(summarize("terminal", undefined, emptyDoneScreen)).toBeUndefined();
  });

  test("returns undefined for status chrome without an answer", () => {
    expect(summarize("claude", undefined, claudeChromeOnlyScreen)).toBeUndefined();
    expect(summarize("codex", undefined, codexChromeOnlyScreen)).toBeUndefined();
    expect(summarize("terminal", undefined, claudeChromeOnlyScreen)).toBeUndefined();
    expect(summarize("terminal", undefined, codexChromeOnlyScreen)).toBeUndefined();
  });

  test.each([
    ["Claude", "claude", claudeWrappedComposerScreen],
    ["Codex", "codex", codexWrappedComposerScreen],
  ] as const)(
    "excludes wrapped %s composer rows from adapter and fallback",
    (_name, program, rows) => {
      expect(summarize(program, undefined, rows)).toBeUndefined();
      expect(summarize("terminal", undefined, rows)).toBeUndefined();
    },
  );
});
