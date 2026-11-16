import type { CheckTaskRequest, Role } from "@herdr-mobile/protocol";
import type { TaskRow } from "../../model/tasks.ts";
import type { TaskActions } from "../../net/task-actions.ts";
import type { ConnectionState } from "../../store/core.ts";

export type CheckOffChoice = "stop" | "keep-running" | "cancel";

export interface TaskIdentity {
  machineId: string;
  taskId: string;
}

export interface CheckOffCurrent {
  activeMachineId: string | null;
  role: Role | undefined;
  connection: ConnectionState | undefined;
  /** Resolve `identity.taskId` from the task list for the active machine. */
  row: TaskRow | undefined;
}

export interface CheckOffDependencies {
  current(): CheckOffCurrent;
  actions: Pick<TaskActions, "check" | "stop">;
}

export interface CheckOffSheetOption {
  id: CheckOffChoice;
  label: "Stop agent and check off" | "Check off, keep it running" | "Cancel";
}

const sheetOptions: readonly CheckOffSheetOption[] = [
  { id: "stop", label: "Stop agent and check off" },
  { id: "keep-running", label: "Check off, keep it running" },
  { id: "cancel", label: "Cancel" },
];

/** Only Running and Needs you ask before checking off a control-device task. */
export function needsCheckOffSheet(row: TaskRow, role: Role | undefined): boolean {
  return (
    role === "control" &&
    (row.state === "running" || row.state === "needs-you") &&
    checkRequest(row) !== undefined
  );
}

export function checkOffSheetOptions(row: TaskRow, role: Role | undefined): CheckOffSheetOption[] {
  if (!needsCheckOffSheet(row, role)) return [];
  return row.address === undefined ? sheetOptions.slice(1) : [...sheetOptions];
}

/** Resolve a delayed row action from the current task list rather than its menu snapshot. */
export function resolveTaskRow(taskId: string, rows: readonly TaskRow[]): TaskRow | undefined {
  return rows.find((row) => row.id === taskId);
}

/** Gate check-off against the machine, role and connection that are current at submission. */
export function canSubmitCheckOff(
  expectedMachineId: string,
  activeMachineId: string | null,
  role: Role | undefined,
  connection: ConnectionState | undefined,
): boolean {
  return expectedMachineId === activeMachineId && role === "control" && connection === "connected";
}

/** Hide every write choice when the open sheet no longer belongs to a writable connection. */
export function checkOffSheetOptionsFor(
  row: TaskRow,
  expectedMachineId: string,
  activeMachineId: string | null,
  role: Role | undefined,
  connection: ConnectionState | undefined,
): CheckOffSheetOption[] {
  if (!canSubmitCheckOff(expectedMachineId, activeMachineId, role, connection)) return [];
  return checkOffSheetOptions(row, role);
}

/** Re-read writable state before each check-off write, including after stopping a terminal. */
export async function runCheckOff(
  identity: TaskIdentity,
  choice: CheckOffChoice | undefined,
  deps: CheckOffDependencies,
): Promise<"refused" | "ask" | "checked"> {
  let current = deps.current();
  if (!canWriteCheckOff(identity, current)) return "refused";

  if (choice === "cancel") return "refused";
  if (isActive(current.row) && choice === undefined) return "ask";

  if (choice === "stop") {
    if (current.row.address === undefined) return "refused";
    await deps.actions.stop(current.row.address);

    current = deps.current();
    if (!canWriteCheckOff(identity, current)) return "refused";
  }

  const request = checkRequest(current.row);
  if (request === undefined) return "refused";
  await deps.actions.check(request);
  return "checked";
}

function checkRequest(row: TaskRow): CheckTaskRequest | undefined {
  const turn = row.terminal?.turn ?? 0;
  if (row.record !== undefined) return { id: row.record.id, turn };
  if (row.address !== undefined) return { terminal: row.address, turn };
  return undefined;
}

function canWriteCheckOff(
  identity: TaskIdentity,
  current: CheckOffCurrent,
): current is CheckOffCurrent & { row: TaskRow } {
  return (
    canSubmitCheckOff(
      identity.machineId,
      current.activeMachineId,
      current.role,
      current.connection,
    ) &&
    current.row !== undefined &&
    current.row.state !== "checked" &&
    current.row.state !== "not-started"
  );
}

function isActive(row: TaskRow | undefined): boolean {
  return row?.state === "running" || row?.state === "needs-you";
}
