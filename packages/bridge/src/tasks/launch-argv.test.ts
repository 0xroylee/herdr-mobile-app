import { describe, expect, test } from "bun:test";
import type { StartAgentRun } from "@herdr-mobile/protocol";
import { StartAgentError } from "../server/start-agent.ts";
import { launchArgv } from "./launch-argv.ts";

describe("launchArgv", () => {
  test("puts built-in prompts after the option terminator as one argument", () => {
    const task = "Review this change and explain the risks";
    expect(launchArgv({ kind: "program", id: "claude" }, task)).toEqual(["claude", "--", task]);
    expect(launchArgv({ kind: "program", id: "codex" }, task)).toEqual(["codex", "--", task]);
  });

  test("keeps template prompts as the second argument", () => {
    expect(launchArgv({ kind: "template", name: "review" }, "Review this change")).toEqual([
      "review",
      "Review this change",
    ]);
  });

  test.each(["Inspect", "-p inspect this change"])(
    "allows template text without applying program-only guards: %s",
    (task) => {
      expect(launchArgv({ kind: "template", name: "review" }, task)).toEqual(["review", task]);
    },
  );

  test.each([
    ["dash-leading", " -p inspect this"],
    ["whitespace-free", "inspect"],
    ["NUL", "inspect\0 this"],
    ["over-limit UTF-8", `${"a".repeat(8191)} é`],
  ])("refuses %s text with the task copy", (_name, task) => {
    expect(() => launchArgv({ kind: "program", id: "claude" }, task)).toThrow(
      new StartAgentError(422, "task_not_allowed", "Write the task as a sentence."),
    );
  });

  test.each([
    ["NUL", "inspect\0 this"],
    ["over-limit UTF-8", `${"a".repeat(8191)} é`],
  ])("applies common safety limits to template text: %s", (_name, task) => {
    expect(() => launchArgv({ kind: "template", name: "review" }, task)).toThrow(
      new StartAgentError(422, "task_not_allowed", "Write the task as a sentence."),
    );
  });

  test("keeps task text as one argv element with embedded newlines", () => {
    const task = "Review the change\n\nCall out risks";
    const run: StartAgentRun = { kind: "program", id: "codex" };
    expect(launchArgv(run, task)).toEqual(["codex", "--", task]);
  });
});
