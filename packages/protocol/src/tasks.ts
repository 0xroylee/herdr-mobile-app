import type { StartAgentPlacement, StartAgentRun } from "./bridge.ts";
import type { JsonValue } from "./wire.ts";

export const TASKS_DOC_NAME = "herdr-mobile.tasks";

export const TASK_ID_PATTERN = /^tk[0-9a-f]{32}$/;
export const TASK_TEXT_MAX_BYTES = 8 * 1024;
export const TASKS_MAX_RECORDS = 200;
export const TASKS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const TASKS_TARGET_BYTES = 768 * 1024;

export type TaskOrigin = "phone" | "herdr";

export interface TaskOutcome {
  state: "done" | "stopped";
  /** Terminal turn when observed; the phone trusts this outcome only at this turn or when ended. */
  turn: number;
  /** True once the program ended (finished, lost, or removed). */
  ended: boolean;
  /** Bridge clock, for display and debugging only; never compared with a phone clock. */
  at: number;
  /** Done summary from the agent status or terminal screen, capped at 160 characters. */
  summary?: string;
  /** Stopped details reported by the core, so the phone's text survives removal. */
  exit?: { code: number | null; signal: number | null; reason: string | null };
}

export interface TaskRecord {
  id: string;
  origin: TaskOrigin;
  terminal?: string;
  text?: string;
  run?: StartAgentRun;
  folder?: string;
  space?: { id: string };
  tab?: { id: string };
  placement?: StartAgentPlacement;
  createdAt: number;
  createdBy?: { deviceId: string; deviceName: string };
  checkedTurn?: number;
  checkedAt?: number;
  checkedBy?: { deviceId: string; deviceName: string };
  outcome?: TaskOutcome;
}

export interface TasksDocument {
  v: 1;
  tasks: Record<string, TaskRecord>;
}

/** Parse a task document, dropping invalid records while preserving valid siblings. */
export function parseTasksDoc(value: JsonValue): TasksDocument | undefined {
  if (!isJsonObject(value) || value.v !== 1 || !isJsonObject(value.tasks)) return undefined;

  const tasks: Record<string, TaskRecord> = {};
  for (const [key, valueTask] of Object.entries(value.tasks)) {
    const task = parseTaskRecord(valueTask);
    if (task !== undefined && key === task.id) tasks[key] = task;
  }

  return { v: 1, tasks };
}

function parseTaskRecord(value: JsonValue): TaskRecord | undefined {
  if (!isJsonObject(value)) return undefined;

  const { id, origin, createdAt } = value;
  if (
    typeof id !== "string" ||
    !TASK_ID_PATTERN.test(id) ||
    (origin !== "phone" && origin !== "herdr") ||
    !isFiniteNumber(createdAt)
  ) {
    return undefined;
  }

  if (
    ("terminal" in value && typeof value.terminal !== "string") ||
    ("text" in value &&
      (typeof value.text !== "string" || utf8ByteLength(value.text) > TASK_TEXT_MAX_BYTES)) ||
    ("run" in value && !isTaskRun(value.run)) ||
    ("folder" in value && typeof value.folder !== "string") ||
    ("space" in value && !isIdObject(value.space)) ||
    ("tab" in value && !isIdObject(value.tab)) ||
    ("placement" in value && value.placement !== "window" && value.placement !== "core") ||
    ("createdBy" in value && !isDevice(value.createdBy)) ||
    ("checkedTurn" in value && !isFiniteNumber(value.checkedTurn)) ||
    ("checkedAt" in value && !isFiniteNumber(value.checkedAt)) ||
    ("checkedBy" in value && !isDevice(value.checkedBy))
  ) {
    return undefined;
  }

  const task: TaskRecord = { id, origin, createdAt };
  if (typeof value.terminal === "string") task.terminal = value.terminal;
  if (typeof value.text === "string") task.text = value.text;
  if (isTaskRun(value.run)) task.run = value.run;
  if (typeof value.folder === "string") task.folder = value.folder;
  if (isIdObject(value.space)) task.space = { id: value.space.id };
  if (isIdObject(value.tab)) task.tab = { id: value.tab.id };
  if (value.placement === "window" || value.placement === "core") {
    task.placement = value.placement;
  }
  if (isDevice(value.createdBy)) {
    task.createdBy = { deviceId: value.createdBy.deviceId, deviceName: value.createdBy.deviceName };
  }
  if (typeof value.checkedTurn === "number") task.checkedTurn = value.checkedTurn;
  if (typeof value.checkedAt === "number") task.checkedAt = value.checkedAt;
  if (isDevice(value.checkedBy)) {
    task.checkedBy = { deviceId: value.checkedBy.deviceId, deviceName: value.checkedBy.deviceName };
  }
  const outcome = parseTaskOutcome(value.outcome);
  if (outcome !== undefined) task.outcome = outcome;
  return task;
}

function parseTaskOutcome(value: JsonValue | undefined): TaskOutcome | undefined {
  if (
    !isJsonObject(value) ||
    (value.state !== "done" && value.state !== "stopped") ||
    typeof value.turn !== "number" ||
    !Number.isInteger(value.turn) ||
    value.turn < 0 ||
    typeof value.ended !== "boolean" ||
    !isFiniteNumber(value.at)
  ) {
    return undefined;
  }

  const summary = value.summary;
  if (summary !== undefined && (typeof summary !== "string" || Array.from(summary).length > 160)) {
    return undefined;
  }

  let exit: TaskOutcome["exit"];
  if ("exit" in value) {
    exit = parseTaskExit(value.exit);
    if (exit === undefined) return undefined;
  }

  return {
    state: value.state,
    turn: value.turn,
    ended: value.ended,
    at: value.at,
    ...(summary === undefined ? {} : { summary }),
    ...(exit === undefined ? {} : { exit }),
  };
}

function parseTaskExit(value: JsonValue | undefined): TaskOutcome["exit"] {
  if (
    !isJsonObject(value) ||
    !isNullableFiniteNumber(value.code) ||
    !isNullableFiniteNumber(value.signal) ||
    (typeof value.reason !== "string" && value.reason !== null)
  ) {
    return undefined;
  }
  return { code: value.code, signal: value.signal, reason: value.reason };
}

function isNullableFiniteNumber(value: JsonValue | undefined): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isTaskRun(value: JsonValue | undefined): value is StartAgentRun {
  if (!isJsonObject(value)) return false;
  if (value.kind === "program") return typeof value.id === "string";
  if (value.kind === "template") return typeof value.name === "string";
  return false;
}

function isIdObject(value: JsonValue | undefined): value is { id: string } {
  return isJsonObject(value) && typeof value.id === "string";
}

function isDevice(value: JsonValue | undefined): value is { deviceId: string; deviceName: string } {
  return (
    isJsonObject(value) &&
    typeof value.deviceId === "string" &&
    typeof value.deviceName === "string"
  );
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count UTF-8 bytes without relying on a platform-specific TextEncoder global. */
function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}
