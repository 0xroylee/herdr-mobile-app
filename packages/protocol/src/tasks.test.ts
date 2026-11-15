import { describe, expect, test } from "bun:test";
import {
  malformedTaskEntryVariants,
  malformedTasksDocumentVariants,
  validTasksDocument,
} from "./tasks.fixtures.ts";
import {
  parseTasksDoc,
  TASK_ID_PATTERN,
  TASK_TEXT_MAX_BYTES,
  TASKS_MAX_AGE_MS,
  TASKS_MAX_RECORDS,
  TASKS_TARGET_BYTES,
} from "./tasks.ts";

describe("parseTasksDoc", () => {
  test("round-trips the phone, unlinked, from-Herdr, and checked task records", () => {
    expect(parseTasksDoc(validTasksDocument)).toEqual(validTasksDocument);
  });

  test("requires a version 1 object with a tasks object", () => {
    for (const value of malformedTasksDocumentVariants) {
      expect(parseTasksDoc(value)).toBeUndefined();
    }
  });

  test("drops each malformed record without losing valid siblings", () => {
    const good = validTasksDocument.tasks.tk00000000000000000000000000000002;
    for (const { key, record } of malformedTaskEntryVariants) {
      const parsed = parseTasksDoc({ v: 1, tasks: { [good.id]: good, [key]: record } });
      expect(parsed?.tasks).toEqual({ [good.id]: good });
    }
  });

  test("accepts text at 8 KiB and rejects text above the byte limit", () => {
    const task = validTasksDocument.tasks.tk00000000000000000000000000000001;
    const atLimit = { ...task, text: "x".repeat(TASK_TEXT_MAX_BYTES) };
    const overLimit = { ...task, text: "🙂".repeat(TASK_TEXT_MAX_BYTES / 4 + 1) };

    expect(parseTasksDoc({ v: 1, tasks: { [task.id]: atLimit } })?.tasks[task.id]?.text).toBe(
      atLimit.text,
    );
    expect(parseTasksDoc({ v: 1, tasks: { [task.id]: overLimit } })?.tasks).toEqual({});
  });

  test("exports stable id, pruning, and target-size limits", () => {
    expect(TASK_ID_PATTERN.test("tk00000000000000000000000000000001")).toBe(true);
    expect(TASK_ID_PATTERN.test("tk0000000000000000000000000000000A")).toBe(false);
    expect(TASK_TEXT_MAX_BYTES).toBe(8 * 1024);
    expect(TASKS_MAX_RECORDS).toBe(200);
    expect(TASKS_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(TASKS_TARGET_BYTES).toBe(768 * 1024);
  });
});
