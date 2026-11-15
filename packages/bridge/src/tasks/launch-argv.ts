import type { StartAgentRun } from "@herdr-mobile/protocol";
import { StartAgentError } from "../server/start-agent.ts";

const MAX_TASK_BYTES = 8 * 1024;

/** Build a launch argument vector without letting task text become an option or command. */
export function launchArgv(run: StartAgentRun, task: string): string[] {
  const invalid =
    task.includes("\0") ||
    new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES ||
    task.trimStart().startsWith("-") ||
    !/\s/u.test(task);
  if (invalid) {
    throw new StartAgentError(422, "task_not_allowed", "Write the task as a sentence.");
  }

  return run.kind === "program" ? [run.id, "--", task] : [run.name, task];
}
