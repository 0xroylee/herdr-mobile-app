import type { CheckTaskRequest, Role } from "@herdr-mobile/protocol";
import type { TaskRow } from "../../model/tasks.ts";

export type CheckOffChoice = "stop" | "keep-running" | "cancel";

export interface CheckOffActions {
  check(request: CheckTaskRequest): Promise<unknown>;
  stop(address: string): Promise<unknown>;
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

/** Check immediately for Done and Stopped, or carry out the selected active-task sheet action. */
export async function applyCheckOff(
  row: TaskRow,
  role: Role | undefined,
  choice: CheckOffChoice | undefined,
  actions: CheckOffActions,
): Promise<boolean> {
  if (role !== "control") return false;
  const request = checkRequest(row);
  if (request === undefined || row.state === "checked" || row.state === "not-started") return false;

  if (row.state === "running" || row.state === "needs-you") {
    if (choice === undefined || choice === "cancel") return false;
    if (choice === "stop") {
      if (row.address === undefined) return false;
      await actions.stop(row.address);
    }
  }

  await actions.check(request);
  return true;
}

function checkRequest(row: TaskRow): CheckTaskRequest | undefined {
  const turn = row.terminal?.turn ?? 0;
  if (row.record !== undefined) return { id: row.record.id, turn };
  if (row.address !== undefined) return { terminal: row.address, turn };
  return undefined;
}
