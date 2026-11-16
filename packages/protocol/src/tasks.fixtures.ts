// Task document fixtures and type checks, imported by tests and never at runtime.

import type { StartAgentPlacement, StartAgentRun } from "./bridge.ts";
import {
  type TASK_ID_PATTERN,
  TASK_TEXT_MAX_BYTES,
  type TASKS_MAX_AGE_MS,
  type TASKS_MAX_RECORDS,
  type TASKS_TARGET_BYTES,
  type TaskOrigin,
  type TaskRecord,
  type TasksDocument,
} from "./tasks.ts";
import type { JsonValue } from "./wire.ts";

const now = 1_794_600_000_000;

/** One linked phone task, one unlinked phone task, and two checked records. */
export const validTasksDocument = {
  v: 1,
  tasks: {
    tk00000000000000000000000000000001: {
      id: "tk00000000000000000000000000000001",
      origin: "phone",
      terminal: "t1",
      text: "Review the API\n\nCheck error handling",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { id: "sp1" },
      tab: { id: "tb1" },
      placement: "core",
      createdAt: now,
      createdBy: { deviceId: "device-1", deviceName: "Phone" },
    },
    tk00000000000000000000000000000002: {
      id: "tk00000000000000000000000000000002",
      origin: "phone",
      text: "Find the root cause",
      run: { kind: "template", name: "review" },
      folder: "/repo",
      space: { id: "sp1" },
      createdAt: now + 1,
    },
    tk00000000000000000000000000000003: {
      id: "tk00000000000000000000000000000003",
      origin: "herdr",
      terminal: "t3",
      createdAt: now + 2,
      checkedTurn: 2,
      checkedAt: now + 3,
      checkedBy: { deviceId: "device-1", deviceName: "Phone" },
    },
    tk00000000000000000000000000000004: {
      id: "tk00000000000000000000000000000004",
      origin: "phone",
      terminal: "t4",
      text: "Ship the fix",
      createdAt: now + 4,
      checkedTurn: 1,
      checkedAt: now + 5,
    },
  },
} satisfies TasksDocument;

export const malformedTasksDocumentVariants: JsonValue[] = [
  null,
  false,
  [],
  {},
  { tasks: {} },
  { v: 1 },
  { v: 2, tasks: {} },
  { v: 1, tasks: null },
  { v: 1, tasks: [] },
];

const validPhoneTask = validTasksDocument.tasks.tk00000000000000000000000000000001;

/** Each record fails one field rule while leaving a valid sibling available. */
export const malformedTaskEntryVariants: { key: string; record: JsonValue }[] = [
  { key: validPhoneTask.id, record: null },
  { key: validPhoneTask.id, record: { ...validPhoneTask, id: 42 } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, id: "wrong-id" } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, origin: "desktop" } },
  {
    key: "tk00000000000000000000000000000005",
    record: { ...validPhoneTask, id: "tk00000000000000000000000000000006" },
  },
  {
    key: validPhoneTask.id,
    record: { ...validPhoneTask, text: "x".repeat(TASK_TEXT_MAX_BYTES + 1) },
  },
  { key: validPhoneTask.id, record: { ...validPhoneTask, terminal: 1 } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, run: { kind: "program" } } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, folder: null } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, space: { id: 1 } } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, tab: "tb1" } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, placement: "shell" } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, createdAt: "now" } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, createdBy: { deviceId: "d1" } } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, checkedTurn: "one" } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, checkedAt: null } },
  { key: validPhoneTask.id, record: { ...validPhoneTask, checkedBy: { deviceName: "Phone" } } },
];

/** True only when A and B have the same type. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const taskOriginShape: Equals<TaskOrigin, "phone" | "herdr"> = true;
const taskRecordShape: Equals<
  TaskRecord,
  {
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
  }
> = true;
const tasksDocumentShape: Equals<TasksDocument, { v: 1; tasks: Record<string, TaskRecord> }> = true;
const taskIdPatternShape: Equals<typeof TASK_ID_PATTERN, RegExp> = true;
const taskTextLimitShape: Equals<typeof TASK_TEXT_MAX_BYTES, number> = true;
const tasksMaxRecordsShape: Equals<typeof TASKS_MAX_RECORDS, 200> = true;
const tasksMaxAgeShape: Equals<typeof TASKS_MAX_AGE_MS, number> = true;
const tasksTargetBytesShape: Equals<typeof TASKS_TARGET_BYTES, number> = true;

export const exactTaskShapes = [
  taskOriginShape,
  taskRecordShape,
  tasksDocumentShape,
  taskIdPatternShape,
  taskTextLimitShape,
  tasksMaxRecordsShape,
  tasksMaxAgeShape,
  tasksTargetBytesShape,
] as const;

// @ts-expect-error only phone or herdr origins are valid
export const invalidTaskOrigin: TaskOrigin = "desktop";
// @ts-expect-error every task record needs a creation time
export const taskWithoutCreatedAt: TaskRecord = {
  id: "tk00000000000000000000000000000001",
  origin: "phone",
};
