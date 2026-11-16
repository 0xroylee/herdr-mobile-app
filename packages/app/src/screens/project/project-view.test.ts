/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskProject, TaskRow } from "../../model/tasks.ts";
import { routes } from "../../routes.ts";
import {
  accessoryBarView,
  cacheTaskSummaryRead,
  deriveProjectView,
  leaveNewTaskSheet,
  openProjectTaskDetails,
  projectRowActions,
  projectTaskRows,
  shouldReadTaskSummary,
  type TaskSummaryRow,
  taskSummary,
  taskSummaryKey,
} from "./project-view.ts";

const project: TaskProject = { id: "website", name: "Website", folder: "/code/website" };

describe("project task entry routes", () => {
  test("opens details with the draft shown in the project's composer", () => {
    const pushed: unknown[] = [];
    const draft = { text: "Review this", notes: "Keep the checks focused" };

    openProjectTaskDetails({ push: (href) => pushed.push(href) }, "website", draft);

    expect(pushed).toEqual([routes.taskNew("website", JSON.stringify(draft))]);
  });

  test("returns to the opened project or replaces the sheet with the selected project", () => {
    const calls: unknown[] = [];
    const router = {
      back: () => calls.push("back"),
      replace: (href: unknown) => calls.push(href),
    };

    leaveNewTaskSheet(router, { kind: "back" });
    leaveNewTaskSheet(router, { kind: "project", projectId: "core" });

    expect(calls).toEqual(["back", routes.project("core", "composer")]);
  });
});

describe("project task accessory bar", () => {
  test("keeps long agent labels to one line and shortens the home folder", () => {
    const agentName = "A very long agent name that should stay on one line";

    expect(
      accessoryBarView({
        agentName,
        folder: "/Users/roy/work/project",
        home: "/Users/roy",
        disabled: false,
      }),
    ).toEqual({
      agentLabel: agentName,
      folderLabel: "~/work/project",
      labelLines: 1,
      detailsDisabled: false,
    });
    expect(
      accessoryBarView({ agentName: undefined, folder: "", home: undefined, disabled: true }),
    ).toMatchObject({
      agentLabel: "Choose agent",
      folderLabel: "Choose folder",
      detailsDisabled: true,
    });
  });
});

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

  test("keeps same-named projects separate, including an empty requested project", () => {
    const first = row("first", 1);
    first.project = { id: "space-first", name: "Website", folder: "/first" };
    const later = row("later", 2);
    later.project = { id: "space-later", name: "Website", folder: "/later" };
    const emptyProject = { id: "space-empty", name: "Website", folder: "/empty" };
    const emptyView = deriveProjectView({
      project: emptyProject,
      rows: projectTaskRows(emptyProject.id, [first, later]),
      role: "control",
      connection: "connected",
      showChecked: false,
    });

    expect(projectTaskRows("space-later", [first, later])).toEqual([later]);
    expect(emptyView.project).toEqual(emptyProject);
    expect(emptyView.rows).toEqual([]);
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

  test("keeps Copy address when the task terminal has disappeared", () => {
    const task = {
      ...row("gone", 1),
      record: { id: "task-gone" } as TaskRow["record"],
      terminal: undefined,
    };
    expect(projectRowActions(task, "watch", "connected")).toEqual([
      { id: "copy-address", label: "Copy address" },
    ]);
  });

  test("does not expose the composer for Other", () => {
    expect(
      deriveProjectView({
        project: { id: "other", name: "Other", folder: undefined },
        rows: [],
        role: "control",
        connection: "connected",
        showChecked: false,
      }).showComposer,
    ).toBe(false);
  });

  test("uses an ended kept terminal's status message when the cache is empty", () => {
    const ended = summaryRow("done", {
      terminal: {
        state: "live",
        turn: 3,
        reason: "exited",
        status: { state: "done", msg: "Status message" },
      },
      lastSeenStatus: { state: "done", msg: "Older status" },
    });

    expect(taskSummary(ended, {})).toBe("Status message");
    expect(shouldReadTaskSummary(ended, {})).toBe(false);
  });

  test("uses cached output when an ended kept terminal has no status message", () => {
    const ended = summaryRow("done", {
      terminal: { state: "live", turn: 3, reason: "exited", status: null },
    });
    const cache = { [taskSummaryKey(ended)]: "Finished the task" };

    expect(taskSummary(ended, cache)).toBe("Finished the task");
    expect(shouldReadTaskSummary(ended, cache)).toBe(false);
  });

  test("reads finished terminals with exit metadata whether or not they were kept", () => {
    for (const keep of [false, true]) {
      const finished = summaryRow("done", {
        terminal: {
          state: "finished",
          turn: 3,
          reason: "exited",
          keep,
          exit_code: 0,
          status: null,
        },
      });
      const cache = { [taskSummaryKey(finished)]: "Finished the task" };

      expect(taskSummary(finished, {})).toBeUndefined();
      expect(shouldReadTaskSummary(finished, {})).toBe(true);
      expect(taskSummary(finished, cache)).toBe("Finished the task");
      expect(shouldReadTaskSummary(finished, cache)).toBe(false);
    }
  });

  test("excludes a live kept shell from lazy reads and cache writes", () => {
    const ended = summaryRow("done", {
      terminal: {
        state: "live",
        turn: 3,
        reason: "exited",
        keep: true,
        status: null,
      },
    });

    expect(taskSummary(ended, {})).toBe("No summary yet.");
    expect(shouldReadTaskSummary(ended, {})).toBe(false);
    expect(cacheTaskSummaryRead({}, ended, ended.terminal, "Shell prompt")).toEqual({});
  });

  test("Project caches a successful read from a finished terminal with reason exited", () => {
    const finished = summaryRow("done", {
      terminal: {
        state: "finished",
        turn: 3,
        reason: "exited",
        keep: false,
        exit_code: 0,
        status: null,
      },
    });
    const cache = cacheTaskSummaryRead({}, finished, finished.terminal, "Finished the task");

    expect(cache).toEqual({ [taskSummaryKey(finished)]: "Finished the task" });
    expect(taskSummary(finished, cache)).toBe("Finished the task");
    expect(cacheTaskSummaryRead({}, finished, finished.terminal, undefined)).toEqual({
      [taskSummaryKey(finished)]: "No summary yet.",
    });
  });

  test("leaves a live Done row pending until its lazy screen read is cached", () => {
    const live = summaryRow("done", {
      terminal: { state: "live", turn: 3, reason: null, status: { state: "done", msg: "  " } },
    });
    const cache = { [taskSummaryKey(live)]: "Screen summary" };

    expect(taskSummary(live, {})).toBeUndefined();
    expect(shouldReadTaskSummary(live, {})).toBe(true);
    expect(taskSummary(live, cache)).toBe("Screen summary");
    expect(shouldReadTaskSummary(live, cache)).toBe(false);
  });

  test("uses a stopped row's last-seen message and falls back when its terminal is missing", () => {
    const stopped = summaryRow("stopped", {
      terminal: undefined,
      lastSeenStatus: { state: "working", msg: "Last update" },
    });
    const withoutMessage = { ...stopped, lastSeenStatus: undefined };

    expect(taskSummary(stopped, {})).toBe("Last update");
    expect(taskSummary(withoutMessage, {})).toBe("No summary yet.");
  });

  test("shows the fallback when the Done terminal is missing", () => {
    const missing = summaryRow("done", { terminal: undefined });

    expect(taskSummary(missing, {})).toBe("No summary yet.");
    expect(shouldReadTaskSummary(missing, {})).toBe(false);
  });
});

function summaryRow(
  state: "done" | "stopped",
  options: {
    terminal?: Partial<NonNullable<TaskSummaryRow["terminal"]>>;
    lastSeenStatus?: TaskSummaryRow["lastSeenStatus"];
  },
): TaskSummaryRow {
  const task = row("summary", 1, state);
  return {
    ...task,
    address: "terminal-summary",
    terminal:
      options.terminal === undefined
        ? undefined
        : ({
            address: "terminal-summary",
            argv: [],
            cols: 80,
            created_ms: 1,
            cwd: "/code/website",
            labels: {},
            rows: 24,
            screen: "exact",
            ...options.terminal,
          } as TaskSummaryRow["terminal"]),
    lastSeenStatus: options.lastSeenStatus,
  };
}

function row(id: string, createdAt: number, state: TaskRow["state"] = "running"): TaskRow {
  return {
    id,
    record: undefined,
    address: `terminal-${id}`,
    terminal: { address: `terminal-${id}`, turn: 0 } as unknown as TaskRow["terminal"],
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
