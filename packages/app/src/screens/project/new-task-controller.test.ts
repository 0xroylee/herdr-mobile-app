/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  AgentCatalog,
  Layout,
  StartAgentRun,
  StartTaskReply,
  StartTaskRequest,
  TaskRecord,
  Terminal,
} from "@herdr-mobile/protocol";
import { BridgeApiError } from "../../net/bridge-api.ts";
import {
  buildTaskText,
  createNewTaskDetailsController,
  NewTaskController,
  type NewTaskPort,
  runNeedsHerdrOpen,
  startableHomeProjects,
  submitNewTaskSheet,
} from "./new-task-controller.ts";
import { leaveNewTaskSheet } from "./project-view.ts";

describe("new task controller", () => {
  test("does nothing when the title is empty", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    const before = controller.state;

    expect(await controller.go()).toBe("empty");
    expect(controller.state).toEqual(before);
    expect(port.calls.start).toEqual([]);
  });

  test("builds title and notes with one blank line and starts the selected task", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    controller.setText("  Check the broken links  ");
    controller.setNotes("  Skip external links that time out.  ");

    expect(buildTaskText(controller.state.draft.text, controller.state.draft.notes)).toBe(
      "Check the broken links\n\nSkip external links that time out.",
    );
    expect(await controller.go()).toBe("started");
    expect(port.calls.start).toEqual([
      {
        text: "Check the broken links\n\nSkip external links that time out.",
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "existing", id: "sp1" },
      },
    ]);
    expect(port.calls.rememberRun).toEqual([
      { machineId: "machine-1", run: { kind: "program", id: "claude" } },
    ]);
    expect(port.calls.rememberFolder).toEqual([
      { machineId: "machine-1", folder: "/Users/roy/project" },
    ]);
    expect(controller.state.draft).toMatchObject({ text: "", notes: "" });
  });

  test("defaults the folder to the selected project's folder and prefers lastRun", () => {
    const port = fakePort();
    const controller = new NewTaskController(port.value, context(), {
      project: { kind: "existing", id: "sp1" },
    });
    controller.setContext({ ...context(), lastRun: { kind: "program", id: "codex" } });

    expect(controller.state.draft).toMatchObject({
      project: { kind: "existing", id: "sp1" },
      folder: "/Users/roy/project",
      run: { kind: "program", id: "codex" },
    });
  });

  test("keeps canceled details edits separate from the original project composer", async () => {
    const port = fakePort();
    const taskContext = contextWithProjects();
    const composer = new NewTaskController(port.value, taskContext, {
      project: { kind: "existing", id: "sp1" },
    });
    await composer.load();
    composer.setText("Inline draft stays here");
    composer.setNotes("Inline notes stay here");

    const sheet = createNewTaskDetailsController(port.value, taskContext, "sp1", {
      ...composer.state.draft,
    });
    await sheet.load();
    expect(sheet).not.toBe(composer);
    sheet.setProject({ kind: "existing", id: "sp2" });
    sheet.setText("Canceled details edit");

    const navigation: string[] = [];
    leaveNewTaskSheet(
      { back: () => navigation.push("back"), replace: () => undefined },
      {
        kind: "back",
      },
    );

    expect(navigation).toEqual(["back"]);
    expect(composer.state.draft).toMatchObject({
      text: "Inline draft stays here",
      notes: "Inline notes stay here",
      project: { kind: "existing", id: "sp1" },
    });
    expect(sheet.state.draft).toMatchObject({
      text: "Canceled details edit",
      project: { kind: "existing", id: "sp2" },
    });
    expect(port.calls.start).toEqual([]);
  });

  test("closes after a same-project Add and keeps the inline composer on that project", async () => {
    const port = fakePort();
    const taskContext = contextWithProjects();
    const composer = new NewTaskController(port.value, taskContext, {
      project: { kind: "existing", id: "sp1" },
    });
    await composer.load();
    composer.setText("Inline task remains available");

    const sheet = createNewTaskDetailsController(port.value, taskContext, "sp1", {
      project: { kind: "existing", id: "sp1" },
    });
    await sheet.load();
    sheet.setText("Add inside the same project");
    const destinations: unknown[] = [];

    expect(
      await submitNewTaskSheet(sheet, "sp1", taskContext.layout, (destination) =>
        destinations.push(destination),
      ),
    ).toBe("started");
    expect(destinations).toEqual([{ kind: "back" }]);
    expect(port.calls.start[0]?.space).toEqual({ kind: "existing", id: "sp1" });

    expect(composer.state.draft).toMatchObject({
      text: "Inline task remains available",
      project: { kind: "existing", id: "sp1" },
    });
    composer.setText("Next inline go");
    expect(await composer.go()).toBe("started");
    expect(port.calls.start[1]?.space).toEqual({ kind: "existing", id: "sp1" });
  });

  test("navigates after adding in another or a new project without changing the inline target", async () => {
    const taskContext = contextWithProjects();
    const port = fakePort();
    const composer = new NewTaskController(port.value, taskContext, {
      project: { kind: "existing", id: "sp1" },
    });
    await composer.load();
    composer.setText("Keep the original project target");

    const sheet = createNewTaskDetailsController(port.value, taskContext, "sp1", {
      project: { kind: "existing", id: "sp1" },
    });
    await sheet.load();
    sheet.setProject({ kind: "existing", id: "sp2" });
    sheet.setText("Add in Core");
    const destinations: unknown[] = [];
    expect(
      await submitNewTaskSheet(sheet, "sp1", taskContext.layout, (destination) =>
        destinations.push(destination),
      ),
    ).toBe("started");
    expect(destinations).toEqual([{ kind: "project", projectId: "sp2" }]);
    expect(port.calls.start[0]?.space).toEqual({ kind: "existing", id: "sp2" });

    const newProjectPort = fakePort({
      start: async () => ({
        record: { ...record(), space: { id: "sp-new" } },
        start: { ...startReply(), space: { id: "sp-new", isNew: true } },
      }),
    });
    const newProjectSheet = createNewTaskDetailsController(
      newProjectPort.value,
      taskContext,
      "sp1",
      {
        project: { kind: "existing", id: "sp1" },
      },
    );
    await newProjectSheet.load();
    newProjectSheet.setProject({ kind: "new" });
    newProjectSheet.setProjectName("New docs");
    newProjectSheet.setFolder("/Users/roy/new-docs");
    newProjectSheet.setText("Add in a new project");
    const newProjectDestinations: unknown[] = [];
    expect(
      await submitNewTaskSheet(newProjectSheet, "sp1", taskContext.layout, (destination) =>
        newProjectDestinations.push(destination),
      ),
    ).toBe("started");
    expect(newProjectDestinations).toEqual([{ kind: "project", projectId: "sp-new" }]);

    expect(composer.state.draft.project).toEqual({ kind: "existing", id: "sp1" });
    composer.setText("Next inline go");
    expect(await composer.go()).toBe("started");
    expect(port.calls.start[1]?.space).toEqual({ kind: "existing", id: "sp1" });
  });

  test("shows needs Herdr open only for extra programs when the window is closed", () => {
    expect(
      runNeedsHerdrOpen({ ...catalog(), windowOpen: false }, { kind: "program", id: "printf" }),
    ).toBe(true);
    expect(
      runNeedsHerdrOpen({ ...catalog(), windowOpen: false }, { kind: "program", id: "claude" }),
    ).toBe(false);
    expect(
      runNeedsHerdrOpen({ ...catalog(), windowOpen: false }, { kind: "template", name: "review" }),
    ).toBe(false);
    expect(runNeedsHerdrOpen(catalog(), { kind: "program", id: "printf" })).toBe(false);
  });

  test("blocks a closed-window extra program before starting with the bridge explanation", async () => {
    const port = fakePort({ catalog: async () => ({ ...catalog(), windowOpen: false }) });
    const controller = createController(port.value);
    await controller.load();
    controller.setRun({ kind: "program", id: "printf" });
    controller.setText("Print a sentence");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "printf gets a first message only while Herdr is open on your Mac.",
      errorCode: "run_not_allowed",
      refreshAvailable: true,
      draft: { text: "Print a sentence" },
    });
    expect(port.calls.start).toEqual([]);
  });

  test("allows Claude Code, Codex and templates when Herdr is closed", async () => {
    const runs: StartAgentRun[] = [
      { kind: "program", id: "claude" },
      { kind: "program", id: "codex" },
      { kind: "template", name: "review" },
    ];
    for (const run of runs) {
      const port = fakePort({ catalog: async () => ({ ...catalog(), windowOpen: false }) });
      const controller = createController(port.value);
      await controller.load();
      controller.setRun(run);
      controller.setText("Review the project files");

      expect(await controller.go()).toBe("started");
      expect(port.calls.start[0]?.run).toEqual(run);
    }
  });

  test("keeps task_not_allowed inline with the draft", async () => {
    const port = fakePort({
      start: async () => {
        throw new BridgeApiError(422, "task_not_allowed", "task rejected");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Build it");
    controller.setNotes("Keep this note");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "Write the task as a sentence.",
      fieldErrors: { task: "Write the task as a sentence." },
      draft: { text: "Build it", notes: "Keep this note" },
    });
  });

  test("maps folder errors inline and requests the folder picker", async () => {
    const port = fakePort({
      start: async () => {
        throw new BridgeApiError(422, "folder_missing", "folder missing");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check this project");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "Choose a folder under an allowed root.",
      fieldErrors: { folder: "Choose a folder under an allowed root." },
      folderPickerRequest: 1,
      draft: { text: "Check this project" },
    });
  });

  test("offers Refresh after run_not_allowed and preserves the draft", async () => {
    const port = fakePort({
      start: async () => {
        throw new BridgeApiError(422, "run_not_allowed", "not allowed");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check this project");
    controller.setNotes("Preserve me");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "That agent isn’t available.",
      refreshAvailable: true,
      draft: { text: "Check this project", notes: "Preserve me" },
    });
  });

  test("preserves the bridge's closed-window message if window state changed after catalog load", async () => {
    const message = "printf gets a first message only while Herdr is open on your Mac.";
    const port = fakePort({
      start: async () => {
        throw new BridgeApiError(422, "run_not_allowed", message);
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setRun({ kind: "program", id: "printf" });
    controller.setText("Print a sentence");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({ error: message, refreshAvailable: true });
  });

  test("uses the bridge message for other errors and keeps the draft", async () => {
    const port = fakePort({
      start: async () => {
        throw new BridgeApiError(503, "core_unavailable", "The core did not respond.");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check this project");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "The core did not respond.",
      draft: { text: "Check this project" },
    });
  });

  for (const [code, message] of [
    ["herdr_app_failed", "Herdr could not create a tab."],
    ["herdr_app_timeout", "Herdr took too long to respond."],
    ["tasks_full", "The task list is full."],
  ] as const) {
    test(`keeps the mapped ${code} bridge message`, async () => {
      const port = fakePort({
        start: async () => {
          throw new BridgeApiError(409, code, message);
        },
      });
      const controller = createController(port.value);
      await controller.load();
      controller.setText("Keep the draft after this error");
      controller.setNotes("And its details");

      expect(await controller.go()).toBe("failed");
      expect(controller.state).toMatchObject({
        error: message,
        draft: { text: "Keep the draft after this error", notes: "And its details" },
      });
    });
  }

  test("maps transport failures to the connection copy and keeps both fields for Retry", async () => {
    const port = fakePort({
      start: async () => {
        throw new TypeError("Network request failed");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check the project");
    controller.setNotes("Keep this note on retry");

    expect(await controller.go()).toBe("failed");
    expect(controller.state).toMatchObject({
      error: "Can’t reach your Mac.",
      refreshAvailable: false,
      draft: { text: "Check the project", notes: "Keep this note on retry" },
    });
  });

  for (const [code, status] of [
    ["connection_lost", 503],
    ["request_timeout", 504],
  ] as const) {
    test(`maps secure transport ${code} to the connection copy and preserves Retry`, async () => {
      let attempts = 0;
      const port = fakePort({
        start: async () => {
          attempts += 1;
          if (attempts === 1) throw new BridgeApiError(status, code, "secure transport detail");
          return { record: record(), start: startReply() };
        },
      });
      const controller = createController(port.value);
      await controller.load();
      controller.setText("Check the project");
      controller.setNotes("Keep this note on retry");

      expect(await controller.go()).toBe("failed");
      expect(controller.state).toMatchObject({
        error: "Can’t reach your Mac.",
        errorCode: code,
        refreshAvailable: false,
        draft: { text: "Check the project", notes: "Keep this note on retry" },
      });

      expect(await controller.go()).toBe("started");
      expect(port.calls.start).toHaveLength(2);
      expect(port.calls.start[1]).toMatchObject({
        text: "Check the project\n\nKeep this note on retry",
      });
    });
  }

  test("keeps the successful record optimistic until the document refetch includes it", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check this project");
    expect(await controller.go()).toBe("started");
    expect(controller.state.optimisticRecords.map(({ id }) => id)).toEqual([
      "tk0000000000000000000000000000001",
    ]);

    controller.reconcileTasks({});
    expect(controller.state.optimisticRecords.map(({ id }) => id)).toEqual([
      "tk0000000000000000000000000000001",
    ]);
    controller.reconcileTasks({ [record().id]: record() });
    expect(controller.state.optimisticRecords).toEqual([]);
  });

  test("keeps an accepted record when a second start fails before the document updates", async () => {
    let starts = 0;
    const port = fakePort({
      start: async () => {
        starts += 1;
        if (starts === 1) return { record: record(), start: startReply() };
        throw new BridgeApiError(503, "core_unavailable", "Can’t reach your Mac.");
      },
    });
    const controller = createController(port.value);
    await controller.load();
    controller.setText("First accepted task");
    expect(await controller.go()).toBe("started");
    controller.setText("Second task");
    controller.setNotes("This one will fail");

    expect(await controller.go()).toBe("failed");
    expect(controller.state.optimisticRecords.map(({ id }) => id)).toEqual([record().id]);
    expect(controller.state.draft).toMatchObject({
      text: "Second task",
      notes: "This one will fail",
    });
    controller.reconcileTasks({});
    expect(controller.state.optimisticRecords.map(({ id }) => id)).toEqual([record().id]);

    controller.reconcileTasks({ [record().id]: record() });
    expect(controller.state.optimisticRecords).toEqual([]);
  });

  test("resolves a label-backed project to its target and lists every valid Home project", () => {
    const port = fakePort();
    const labelContext = { ...context(), layout: undefined, terminals: [] as Terminal[] };
    const controller = new NewTaskController(port.value, labelContext, {
      project: { kind: "existing", id: "label-space:sp2" },
    });
    expect(controller.state.draft.project).toEqual({ kind: "existing", id: "label-space:sp2" });

    controller.setContext({
      ...labelContext,
      terminals: [terminal("sp1"), terminal("sp2")],
    });
    expect(controller.state.draft.project).toEqual({ kind: "existing", id: "sp2" });
    expect(
      startableHomeProjects(
        [
          { id: "label-space:sp1", name: "Project One" },
          { id: "label-space:sp2", name: "Project Two" },
        ],
        controller.state.options.spaceChoices,
        undefined,
      ).map(({ id }) => id),
    ).toEqual(["label-space:sp1", "label-space:sp2"]);
  });

  test("keeps an unavailable requested project instead of switching to the first choice", async () => {
    const port = fakePort();
    const controller = new NewTaskController(port.value, context(), {
      project: { kind: "existing", id: "missing-project" },
    });
    await controller.load();
    controller.setText("Do not start in another project");

    expect(controller.state.draft.project).toEqual({ kind: "existing", id: "missing-project" });
    expect(await controller.go()).toBe("invalid");
    expect(controller.state.error).toBe("This project isn’t available.");
    expect(port.calls.start).toEqual([]);
  });

  test("preserves a new project name across context and catalog refreshes", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    controller.setProject({ kind: "new" });
    controller.setProjectName("New docs");
    controller.setFolder("/Users/roy/new-docs");
    controller.setContext({ ...context(), terminals: [terminal(), terminal("sp2")] });
    await controller.load();
    controller.setText("Create the project overview");

    expect(controller.state.draft.project).toEqual({ kind: "new", name: "New docs" });
    expect(await controller.go()).toBe("started");
    expect(port.calls.start[0]?.space).toEqual({ kind: "new", name: "New docs" });
  });

  test("does not start from a watch device", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Stay read only");
    controller.setContext({ ...context(), role: "watch" });

    expect(await controller.go()).toBe("unavailable");
    expect(controller.state.draft.text).toBe("Stay read only");
    expect(port.calls.start).toEqual([]);
  });

  test("does not submit when disconnected and keeps the typed draft", async () => {
    const port = fakePort();
    const controller = createController(port.value);
    await controller.load();
    controller.setText("Check this project");
    controller.setContext({ ...context(), connected: false });

    expect(await controller.go()).toBe("unavailable");
    expect(controller.state.error).toBe("Can’t reach your Mac.");
    expect(controller.state.draft.text).toBe("Check this project");
    expect(port.calls.start).toEqual([]);
  });
});

function createController(port: NewTaskPort): NewTaskController {
  return new NewTaskController(port, context(), { project: { kind: "existing", id: "sp1" } });
}

function context() {
  return {
    machineId: "machine-1",
    role: "control" as const,
    connected: true,
    layout: layout(),
    terminals: [terminal()],
    recentFolders: [],
    lastRun: undefined,
  };
}

function contextWithProjects() {
  const taskContext = context();
  return {
    ...taskContext,
    layout: {
      spaces: [
        ...taskContext.layout.spaces,
        { id: "sp2", name: "Core", folder: "/Users/roy/core", tabs: [] },
      ],
    },
  };
}

function fakePort(overrides: Partial<NewTaskPort> = {}) {
  const calls = {
    start: [] as StartTaskRequest[],
    rememberRun: [] as { machineId: string; run: StartAgentRun }[],
    rememberFolder: [] as { machineId: string; folder: string }[],
  };
  const value: NewTaskPort = {
    catalog: async () => overrides.catalog?.() ?? catalog(),
    start: async (request) => {
      calls.start.push(request);
      return overrides.start ? overrides.start(request) : { record: record(), start: startReply() };
    },
    rememberRun: (machineId, run) => {
      calls.rememberRun.push({ machineId, run });
      overrides.rememberRun?.(machineId, run);
    },
    rememberFolder: (machineId, folder) => {
      calls.rememberFolder.push({ machineId, folder });
      overrides.rememberFolder?.(machineId, folder);
    },
  };
  return { value, calls };
}

function catalog(): AgentCatalog {
  return {
    programs: ["claude", "codex", "printf"],
    templates: [{ name: "review", description: "Review changes" }],
    roots: ["/Users/roy"],
    home: "/Users/roy",
    windowOpen: true,
  };
}

function layout(): Layout {
  return {
    spaces: [
      {
        id: "sp1",
        name: "Work",
        folder: "/Users/roy/project",
        tabs: [{ id: "tb1", name: "Main", terminalAddresses: ["t1"] }],
      },
    ],
  };
}

function terminal(spaceId = "sp1"): Terminal {
  return {
    address: `terminal-${spaceId}`,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: `/Users/roy/${spaceId}/src`,
    labels: { "herdr.space": spaceId },
    rows: 24,
    screen: "exact",
    state: "live",
  };
}

function record(): TaskRecord {
  return {
    id: "tk0000000000000000000000000000001",
    origin: "phone",
    text: "Check this project",
    run: { kind: "program", id: "claude" },
    folder: "/Users/roy/project",
    space: { id: "sp1" },
    createdAt: 10,
  };
}

function startReply(): StartTaskReply["start"] {
  return {
    placement: "window",
    address: "t1",
    space: { id: "sp1", isNew: false },
    tab: { id: "tb2", isNew: true },
  };
}
