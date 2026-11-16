/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  AgentCatalog,
  Layout,
  StartTaskReply,
  StartTaskRequest,
  TaskRecord,
} from "@herdr-mobile/protocol";
import { BridgeApiError } from "../../net/bridge-api.ts";
import type { BridgeCalls } from "../../net/bridge-calls.ts";
import type { ConnectionManager } from "../../net/connection.ts";
import {
  createNewTaskDetailsController,
  type NewTaskContext,
  NewTaskController,
  submitNewTaskSheet,
} from "./new-task-controller.ts";
import { bindNewTaskController, createHomeProject, createNewTaskPort } from "./new-task-port.ts";
import { leaveNewTaskSheet } from "./project-view.ts";

describe("Home project creation adapter", () => {
  test("forwards the entered Name and Folder through createNewSpace", async () => {
    const calls: unknown[][] = [];
    const result = await createHomeProject(
      {
        appDo: async (...args: Parameters<BridgeCalls["appDo"]>) => {
          calls.push(args);
          return { ok: true };
        },
      },
      { id: "machine-1", role: "control" },
      "  Docs  ",
      "  /Users/roy/docs  ",
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["space.new", { name: "Docs", folder: "/Users/roy/docs" }]]);
  });

  test("keeps createNewSpace role and Herdr error handling", async () => {
    const calls: unknown[][] = [];
    const dependencies = {
      appDo: async (...args: Parameters<BridgeCalls["appDo"]>) => {
        calls.push(args);
        throw new BridgeApiError(409, "herdr_not_running", "Conflict");
      },
    };

    await expect(
      createHomeProject(dependencies, { id: "machine-1", role: "watch" }, "Docs", "/docs"),
    ).resolves.toEqual({ ok: false, message: "This device is read-only." });
    expect(calls).toEqual([]);

    await expect(
      createHomeProject(dependencies, { id: "machine-1", role: "control" }, "Docs", "/docs"),
    ).resolves.toEqual({ ok: false, message: "Herdr isn't running on your Mac" });
    expect(calls).toEqual([["space.new", { name: "Docs", folder: "/docs" }]]);
  });
});

describe("NewTaskPort adapter", () => {
  test("persists the selected run and folder through the current settings adapter", () => {
    const remembered: unknown[][] = [];
    const port = createNewTaskPort(
      {
        agentCatalog: async () => ({
          programs: [],
          templates: [],
          roots: [],
          home: "/Users/roy",
          windowOpen: true,
        }),
        startTask: async () => {
          throw new Error("Start is not used by this test");
        },
      },
      {
        rememberRun: (...args) => remembered.push(args),
        rememberFolder: (...args) => remembered.push(args),
      },
    );

    port.rememberRun("machine-1", { kind: "program", id: "codex" });
    port.rememberFolder("machine-1", "/Users/roy/project");

    expect(remembered).toEqual([
      ["machine-1", { kind: "program", id: "codex" }],
      ["machine-1", "/Users/roy/project"],
    ]);
  });

  test("Project screen binding uses the replacement manager after a Mac switch", async () => {
    const preferences = noPreferences();
    const first = managerHarness();
    const selectedMac = managerHarness();
    const taskContext = context("mac-a");
    const controller = new NewTaskController(
      createNewTaskPort(first.manager.calls(), preferences),
      taskContext,
      { project: { kind: "existing", id: "sp1" } },
    );

    bindNewTaskController(controller, first.manager, taskContext, preferences);
    await controller.load();
    bindNewTaskController(controller, selectedMac.manager, context("mac-b"), preferences);
    controller.setText("Start on the selected Mac");

    expect(await controller.go()).toBe("started");
    expect(first.state.catalogCalls).toBe(1);
    expect(first.state.requests).toEqual([]);
    expect(selectedMac.state.requests).toEqual([
      {
        text: "Start on the selected Mac",
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "existing", id: "sp1" },
      },
    ]);
  });

  test("Details Retry uses the replacement manager and routes the accepted request", async () => {
    const preferences = noPreferences();
    const first = managerHarness(async () => {
      throw new Error("The first manager is unavailable");
    });
    const replacement = managerHarness();
    const taskContext = context("mac-a");
    const controller = createNewTaskDetailsController(
      createNewTaskPort(first.manager.calls(), preferences),
      taskContext,
      "sp1",
      { project: { kind: "existing", id: "sp1" } },
    );
    bindNewTaskController(controller, first.manager, taskContext, preferences);
    await controller.load();
    controller.setText("Keep this task for Retry");
    const navigation: unknown[] = [];
    const router = {
      back: () => navigation.push("back"),
      replace: (href: unknown) => navigation.push(href),
    };
    const submit = () =>
      submitNewTaskSheet(controller, "sp1", taskContext.layout, (destination) =>
        leaveNewTaskSheet(router, destination),
      );

    expect(await submit()).toBe("failed");
    expect(controller.state.draft.text).toBe("Keep this task for Retry");
    expect(navigation).toEqual([]);

    bindNewTaskController(controller, replacement.manager, taskContext, preferences);
    expect(await submit()).toBe("started");
    expect(replacement.state.requests).toHaveLength(1);
    expect(replacement.state.requests[0]?.text).toBe("Keep this task for Retry");
    expect(navigation).toEqual(["back"]);
    expect(controller.state.draft.text).toBe("");
  });
});

function managerHarness(
  start: (request: StartTaskRequest) => Promise<StartTaskReply> = async (request) =>
    acceptedReply(request),
) {
  const state = { catalogCalls: 0, requests: [] as StartTaskRequest[] };
  const manager: Pick<ConnectionManager, "calls"> = {
    calls: () =>
      ({
        agentCatalog: async () => {
          state.catalogCalls += 1;
          return taskCatalog();
        },
        startTask: async (request) => {
          state.requests.push(request);
          return start(request);
        },
      }) as BridgeCalls,
  };
  return { manager, state };
}

function noPreferences() {
  return { rememberRun: () => undefined, rememberFolder: () => undefined };
}

function context(machineId: string): NewTaskContext {
  const layout: Layout = {
    spaces: [
      {
        id: "sp1",
        name: "Work",
        folder: "/Users/roy/project",
        tabs: [],
      },
    ],
  };
  return {
    machineId,
    role: "control",
    connected: true,
    layout,
    terminals: [],
    recentFolders: [],
    lastRun: undefined,
  };
}

function taskCatalog(): AgentCatalog {
  return {
    programs: ["claude"],
    templates: [],
    roots: ["/Users/roy"],
    home: "/Users/roy",
    windowOpen: true,
  };
}

function acceptedReply(request: StartTaskRequest): StartTaskReply {
  const spaceId = request.space.kind === "existing" ? request.space.id : "created-space";
  const record: TaskRecord = {
    id: "tk0000000000000000000000000000001",
    origin: "phone",
    text: request.text,
    run: request.run,
    folder: request.folder,
    space: { id: spaceId },
    createdAt: 1,
  };
  return {
    record,
    start: {
      placement: "window",
      space: { id: spaceId, isNew: request.space.kind === "new" },
      tab: { id: "tb1", isNew: true },
    },
  };
}
