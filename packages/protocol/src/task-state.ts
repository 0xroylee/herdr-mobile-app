import type { Status, Terminal } from "./generated/hc-api.ts";
import type { TaskRecord } from "./tasks.ts";

export type TaskState = "checked" | "stopped" | "done" | "needs-you" | "running" | "not-started";

/** Apply the task state table in priority order. */
export function taskState(
  record: TaskRecord | undefined,
  terminal: Terminal | undefined,
  lastSeen: Status | null | undefined,
): TaskState {
  const ended = isEnded(terminal);
  if (record?.checkedTurn !== undefined && (ended || (terminal?.turn ?? 0) <= record.checkedTurn)) {
    return "checked";
  }
  if (record !== undefined && record.terminal === undefined && terminal === undefined) {
    return "running";
  }

  const status = terminal?.status;
  const evidenceStatus = ended || status == null ? (lastSeen ?? status) : status;
  const doneEvidence =
    evidenceStatus?.state === "done" || (terminal?.exit_code === 0 && (terminal.turn ?? 0) >= 1);
  if (ended) return doneEvidence ? "done" : "stopped";

  if (status == null && lastSeen?.state === "done") return "done";
  if (status?.state === "done" || (status?.state === "idle" && (terminal?.turn ?? 0) >= 1)) {
    return "done";
  }
  if (status?.state === "blocked" || status?.state === "error") return "needs-you";
  if (
    status?.state === "working" ||
    status === null ||
    terminal?.status == null ||
    (status?.state === "idle" && (terminal?.turn ?? 0) === 0)
  ) {
    return "running";
  }

  return "running";
}

export function stoppedText(terminal: Terminal | undefined): string {
  if (terminal === undefined) return "The terminal is gone.";
  if (terminal.exit_code !== null && terminal.exit_code !== undefined) {
    return `Exited with code ${terminal.exit_code} before it finished.`;
  }
  if (terminal.signal !== null && terminal.signal !== undefined) {
    return `Stopped by ${terminal.signal} before it finished.`;
  }
  return "Ended before it finished.";
}

export function isEnded(terminal: Terminal | undefined): boolean {
  return terminal === undefined || terminal.state === "finished" || terminal.reason != null;
}
