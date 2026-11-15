/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskProject, TaskRow } from "../../model/tasks.ts";
import { deriveProjectView, projectRowActions } from "./project-view.ts";

const project: TaskProject = { id: "website", name: "Website", folder: "/code/website" };

describe("deriveProjectView", () => {
  test("keeps task creation order and hides checked rows until Show is selected", () => {
    const rows = [row("later", 3), row("checked", 2, "checked"), row("first", 1)];
    const hidden = deriveProjectView({
      project,
      rows,
      role: "control",
      connection: "connected",
      showChecked: false,
    });
    const shown = deriveProjectView({
      project,
      rows,
      role: "control",
      connection: "connected",
      showChecked: true,
    });

    expect(hidden.rows.map(({ id }) => id)).toEqual(["first", "later"]);
    expect(hidden.checkedCount).toBe(1);
    expect(hidden.showChecked).toBe(false);
    expect(shown.rows.map(({ id }) => id)).toEqual(["first", "checked", "later"]);
    expect(shown.showChecked).toBe(true);
  });

  test("enables project actions for a connected control device", () => {
    expect(
      deriveProjectView({
        project,
        rows: [row("checked", 1, "checked")],
        role: "control",
        connection: "connected",
        showChecked: false,
      }),
    ).toMatchObject({
      dimmed: false,
      canCheckOff: true,
      canClear: true,
      showClear: true,
      showComposer: true,
    });
  });

  test("keeps watch and offline presentations read-only", () => {
    const rowset = [row("running", 1)];
    expect(
      deriveProjectView({
        project,
        rows: rowset,
        role: "watch",
        connection: "connected",
        showChecked: false,
      }),
    ).toMatchObject({
      dimmed: false,
      canCheckOff: false,
      canClear: false,
      showClear: false,
      showComposer: false,
    });
    expect(
      deriveProjectView({
        project,
        rows: rowset,
        role: "control",
        connection: "offline",
        showChecked: false,
      }),
    ).toMatchObject({
      dimmed: true,
      canCheckOff: false,
      canClear: false,
      showComposer: false,
      actionsEnabled: false,
    });
  });

  test("keeps terminal actions on watch devices but removes destructive actions", () => {
    const task = row("running", 1);
    expect(projectRowActions(task, "watch", "connected")).toEqual([
      { id: "open-terminal", label: "Open terminal" },
      { id: "copy-address", label: "Copy address" },
    ]);
    expect(projectRowActions(task, "control", "connected").map(({ id }) => id)).toEqual([
      "open-terminal",
      "copy-address",
      "check-off",
    ]);
    expect(projectRowActions(task, "control", "offline")).toEqual([]);
  });
});

function row(id: string, createdAt: number, state: TaskRow["state"] = "running"): TaskRow {
  return {
    id,
    record: undefined,
    address: `terminal-${id}`,
    terminal: undefined,
    title: id,
    program: { name: "Claude Code", iconKey: "claude" },
    state,
    createdAt,
    timestamp: createdAt,
    age: "1m",
    project,
    fromHerdr: false,
    unlinked: false,
    matched: false,
    checked: state === "checked",
    question: undefined,
    stoppedText: undefined,
  };
}
