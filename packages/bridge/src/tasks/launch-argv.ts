import type { StartAgentRun } from "@herdr-mobile/protocol";
import { StartAgentError } from "../server/start-agent.ts";

const MAX_TASK_BYTES = 8 * 1024;

/** Build a launch argument vector without letting task text become an option or command. */
export function launchArgv(run: StartAgentRun, task: string): string[] {
  const invalidCommon =
    task.includes("\0") || new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES;
  const guardedProgram = run.kind === "program" && (run.id === "claude" || run.id === "codex");
  const invalidProgram = guardedProgram && (task.trimStart().startsWith("-") || !/\s/u.test(task));
  const invalid = invalidCommon || invalidProgram;
  if (invalid) {
    throw new StartAgentError(422, "task_not_allowed", "Write the task as a sentence.");
  }

  return run.kind === "program" ? [run.id, "--", task] : [run.name, task];
}
