import type { Role } from "@herdr-mobile/protocol";
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
    showComposer: control && connected,
    actionsEnabled: connected,
  };
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
    actions.push({ id: "open-terminal", label: "Open terminal" });
    actions.push({ id: "copy-address", label: "Copy address" });
  }
  if (role === "control" && row.state !== "checked" && row.state !== "not-started") {
    actions.push({ id: "check-off", label: "Check off" });
  }
  return actions;
}
