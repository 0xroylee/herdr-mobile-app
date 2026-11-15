import type { Role, Status } from "@herdr-mobile/protocol";
import { oneLine } from "../../model/summary.ts";
import type { TaskProject, TaskRow } from "../../model/tasks.ts";
import type { ConnectionState } from "../../store/core.ts";

export interface ProjectView {
  project: TaskProject;
  rows: TaskRow[];
  checkedCount: number;
  showChecked: boolean;
  dimmed: boolean;
  canCheckOff: boolean;
  canClear: boolean;
  showClear: boolean;
  showComposer: boolean;
  actionsEnabled: boolean;
}

export type ProjectRowActionId = "open-terminal" | "copy-address" | "check-off";

export interface ProjectRowAction {
  id: ProjectRowActionId;
  label: "Open terminal" | "Copy address" | "Check off";
}

export type TaskSummaryRow = TaskRow & { lastSeenStatus?: Status | null };

/** Order project tasks by creation time and derive controls from the current role and connection. */
export function deriveProjectView(input: {
  project: TaskProject;
  rows: readonly TaskRow[];
  role: Role | undefined;
  connection: ConnectionState;
  showChecked: boolean;
}): ProjectView {
  const ordered = [...input.rows].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.terminal?.created_ms ?? left.createdAt) -
        (right.terminal?.created_ms ?? right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const checkedCount = ordered.filter((row) => row.checked).length;
  const connected = input.connection === "connected";
  const control = input.role === "control";

  return {
    project: input.project,
    rows: input.showChecked ? ordered : ordered.filter((row) => !row.checked),
    checkedCount,
    showChecked: input.showChecked,
    dimmed: !connected,
    canCheckOff: control && connected,
    canClear: control && connected && checkedCount > 0,
    showClear: control && checkedCount > 0,
    showComposer: control && connected && input.project.id !== "other",
    actionsEnabled: connected,
  };
}

/** Select task rows by the project's stable id, never by its display name. */
export function projectTaskRows(projectId: string, rows: readonly TaskRow[]): TaskRow[] {
  return rows.filter((row) => row.project.id === projectId);
}

/** Whether a Done row needs a lazy screen read to fill its missing summary. */
export function shouldReadTaskSummary(
  row: TaskSummaryRow,
  cache: Readonly<Record<string, string>>,
): boolean {
  return (
    row.state === "done" &&
    row.address !== undefined &&
    row.terminal !== undefined &&
    row.terminal.state !== "finished" &&
    row.terminal.reason == null &&
    statusMessage(row) === undefined &&
    !Object.hasOwn(cache, taskSummaryKey(row))
  );
}

/** Key cached output by task address and turn so clearing status does not discard it. */
export function taskSummaryKey(row: TaskRow): string {
  return `${row.address ?? row.id}:${row.terminal?.turn ?? 0}`;
}

/** Choose the Done or Stopped summary in one fixed source order. */
export function taskSummary(
  row: TaskSummaryRow,
  cache: Readonly<Record<string, string>>,
): string | undefined {
  if (row.state !== "done" && row.state !== "stopped") return undefined;

  const message = statusMessage(row);
  if (message !== undefined) return message;

  const key = taskSummaryKey(row);
  if (Object.hasOwn(cache, key)) return cache[key];

  if (
    row.address === undefined ||
    row.terminal === undefined ||
    row.terminal.state === "finished" ||
    row.terminal.reason != null
  ) {
    return "No summary yet.";
  }

  return undefined;
}

function statusMessage(row: TaskSummaryRow): string | undefined {
  return oneLine((row.terminal?.status ?? row.lastSeenStatus)?.msg);
}

/** Keep read-only terminal actions for watch devices; hide actions while offline. */
export function projectRowActions(
  row: TaskRow,
  role: Role | undefined,
  connection: ConnectionState,
): ProjectRowAction[] {
  if (connection !== "connected") return [];

  const actions: ProjectRowAction[] = [];
  if (row.address !== undefined) {
    if (row.terminal !== undefined) {
      actions.push({ id: "open-terminal", label: "Open terminal" });
    }
    actions.push({ id: "copy-address", label: "Copy address" });
  }
  if (role === "control" && row.state !== "checked" && row.state !== "not-started") {
    actions.push({ id: "check-off", label: "Check off" });
  }
  return actions;
}
