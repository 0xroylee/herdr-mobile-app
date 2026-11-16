/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Layout } from "@herdr-mobile/protocol";
import { deriveStartOptions } from "../../model/startAgent.ts";
import type { TaskRow } from "../../model/tasks.ts";
import { routes } from "../../routes.ts";
import { startableHomeProjects } from "../project/new-task-controller.ts";
import {
  deriveHomeView,
  homeTileGlyph,
  homeTileIconBackground,
  newTaskLabelTone,
  openHomeNewTaskProject,
} from "./home-view.ts";

const layout: Layout = {
  spaces: [
    { id: "website", name: "Website", folder: "/code/website", tabs: [] },
    { id: "core", name: "Core", folder: "/code/core", tabs: [] },
    { id: "empty", name: "Empty", folder: null, tabs: [] },
  ],
};

describe("deriveHomeView", () => {
  test("uses the working activity glyph on the filled working color", () => {
    expect(homeTileGlyph("running")).toBe("activity");
    expect(homeTileIconBackground("running")).toBe("bg-working");
  });

  test("uses the theme foreground tone for the New task label", () => {
    expect(newTaskLabelTone).toBe("fg");
  });

  test("keeps Herdr project order and derives urgent marks and unchecked counts", () => {
    const view = deriveHomeView({
      layout,
      terminals: {},
      rows: [
        row("needs", "website", "Website", "needs-you"),
        row("done", "website", "Website", "done"),
        row("working", "core", "Core", "running"),
        row("stopped", "core", "Core", "stopped"),
        row("checked", "empty", "Empty", "checked"),
      ],
      role: "control",
      connection: "connected",
    });

    expect(view.projects.map(({ id }) => id)).toEqual(["website", "core", "empty"]);
    expect(view.projects.map(({ mark, unchecked }) => [mark, unchecked])).toEqual([
      ["needs-you", 2],
      ["done", 2],
      [undefined, 0],
    ]);
    expect(view.tiles).toEqual([
      { kind: "needs-you", label: "Needs you", count: 1 },
      { kind: "running", label: "Running", count: 1 },
      { kind: "done", label: "Done", count: 2 },
    ]);
  });

  test("searches open tasks by title, project and program", () => {
    const rows = [
      row("title", "website", "Website", "running", "Fix a broken link", "Codex"),
      row("project", "website", "Website", "running", "Update the footer", "Claude Code"),
      row("program", "core", "Core", "done", "Update tests", "Claude Code"),
      row("checked", "website", "Website", "done", "Checked task", "Claude Code", true),
    ];

    expect(
      deriveHomeView({
        layout,
        terminals: {},
        rows,
        role: "control",
        connection: "connected",
        query: "broken",
      }).rows.map(({ id }) => id),
    ).toEqual(["title"]);
    expect(
      deriveHomeView({
        layout,
        terminals: {},
        rows,
        role: "control",
        connection: "connected",
        query: "website",
      }).rows.map(({ id }) => id),
    ).toEqual(["title", "project"]);
    expect(
      deriveHomeView({
        layout,
        terminals: {},
        rows,
        role: "control",
        connection: "connected",
        query: "claude",
      }).rows.map(({ id }) => id),
    ).toEqual(["project", "program"]);
    expect(
      deriveHomeView({
        layout,
        terminals: {},
        rows,
        role: "control",
        connection: "connected",
        query: "website",
      }).projects.map(({ id }) => id),
    ).toEqual(["website"]);
  });

  test("keeps every startable project in the New task picker during an empty search", () => {
    const view = deriveHomeView({
      layout,
      terminals: {},
      rows: [
        row("site-task", "website", "Website", "running", "Fix the site"),
        row("core-task", "core", "Core", "running", "Check the build"),
      ],
      role: "control",
      connection: "connected",
      query: "no task matches this",
    });
    const choices = deriveStartOptions(undefined, layout, {}, [], undefined).spaceChoices;

    expect(view.rows).toEqual([]);
    expect(view.projects).toEqual([]);
    expect(
      startableHomeProjects(view.projectInventory, choices, layout).map(({ id }) => id),
    ).toEqual(["website", "core", "empty"]);
  });

  test("routes a selected Home project to its focused composer", () => {
    const pushed: unknown[] = [];

    openHomeNewTaskProject({ push: (href) => pushed.push(href) }, "core");

    expect(pushed).toEqual([routes.project("core", "composer")]);
  });

  test("dims stale content and hides controls from watch devices", () => {
    expect(
      deriveHomeView({ layout, terminals: {}, rows: [], role: "watch", connection: "connected" }),
    ).toMatchObject({ dimmed: false, showActions: false, actionsEnabled: false });
    expect(
      deriveHomeView({ layout, terminals: {}, rows: [], role: "control", connection: "offline" }),
    ).toMatchObject({ dimmed: true, showActions: true, actionsEnabled: false });
  });
});

function row(
  id: string,
  projectId: string,
  projectName: string,
  state: TaskRow["state"],
  title = id,
  program = "Claude Code",
  checked = state === "checked",
): TaskRow {
  return {
    id,
    record: undefined,
    address: `terminal-${id}`,
    terminal: undefined,
    title,
    program: { name: program, iconKey: "claude" },
    state,
    createdAt: 1,
    timestamp: 1,
    age: "1m",
    project: { id: projectId, name: projectName, folder: undefined },
    fromHerdr: false,
    unlinked: false,
    matched: false,
    checked,
    question: undefined,
    stoppedText: state === "stopped" ? "Ended before it finished." : undefined,
  };
}
