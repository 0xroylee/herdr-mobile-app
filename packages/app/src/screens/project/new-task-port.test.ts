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
import { createConnectionManager } from "../../net/connection.ts";
import { connect, FakeClock, FakeSocket, routeConnection } from "../../net/testing.ts";
import { createCoreStore } from "../../store/core.ts";
import type { Machine } from "../../store/machines.ts";
import { createMemorySecrets, createMemoryStorage } from "../../store/memory.ts";
import { createSettingsStore } from "../../store/settings.ts";
import {
  createNewTaskDetailsController,
  type NewTaskContext,
  NewTaskController,
  submitNewTaskSheet,
} from "./new-task-controller.ts";
import { bindNewTaskScreen, createHomeProject, unavailableNewTaskPort } from "./new-task-port.ts";
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

describe("NewTask screen binding", () => {
  test("Project binding after a Mac switch uses the replacement manager and real settings", async () => {
    const settings = createSettingsStore(createMemoryStorage());
    const first = managerHarness("mac-a");
    const selectedMac = managerHarness("mac-b");
    const firstContext = context("mac-a");
    const controller = new NewTaskController(unavailableNewTaskPort, firstContext, {
      project: { kind: "existing", id: "sp1" },
    });

    await connect(first.manager, first.socket);
    await connect(selectedMac.manager, selectedMac.socket);
    bindNewTaskScreen(controller, first.manager, firstContext, settings.getState());
    await controller.load();

    bindNewTaskScreen(controller, selectedMac.manager, context("mac-b"), settings.getState());
    controller.setText("Start on the selected Mac");

    try {
      expect(await controller.go()).toBe("started");
      expect(first.requests).toEqual([
        {
          url: "https://mac-a.bridge.test/api/agents/catalog",
          authorization: "Bearer token-mac-a",
          method: "GET",
        },
      ]);
      expect(selectedMac.requests).toEqual([
        {
          url: "https://mac-b.bridge.test/api/tasks",
          authorization: "Bearer token-mac-b",
          method: "POST",
        },
      ]);
      expect(settings.getState().lastRun).toEqual({
        "mac-b": { kind: "program", id: "claude" },
      });
      expect(settings.getState().recentFolders).toEqual({
        "mac-b": ["/Users/roy/project"],
      });

      first.manager.stop();
      const requestsBeforeStoppedCall = first.requests.length;
      await expect(first.manager.calls().startTask(startRequest())).rejects.toMatchObject({
        code: "not_connected",
      });
      expect(first.requests).toHaveLength(requestsBeforeStoppedCall);
    } finally {
      first.manager.stop();
      selectedMac.manager.stop();
    }
  });

  test("Details Retry after a failed start uses the replacement manager", async () => {
    const settings = createSettingsStore(createMemoryStorage());
    const first = managerHarness("retry-a", { failStarts: true });
    const replacement = managerHarness("retry-b");
    const firstContext = context("retry-a");
    const controller = createNewTaskDetailsController(unavailableNewTaskPort, firstContext, "sp1", {
      project: { kind: "existing", id: "sp1" },
    });
    await connect(first.manager, first.socket);
    await connect(replacement.manager, replacement.socket);
    bindNewTaskScreen(controller, first.manager, firstContext, settings.getState());
    await controller.load();
    controller.setText("Keep this task for Retry");
    const navigation: unknown[] = [];
    const router = {
      back: () => navigation.push("back"),
      replace: (href: unknown) => navigation.push(href),
    };
    const submit = () =>
      submitNewTaskSheet(controller, "sp1", firstContext.layout, (destination) =>
        leaveNewTaskSheet(router, destination),
      );

    try {
      expect(await submit()).toBe("failed");
      expect(controller.state.draft.text).toBe("Keep this task for Retry");
      expect(navigation).toEqual([]);
      expect(first.requests.map(({ url }) => url)).toEqual([
        "https://retry-a.bridge.test/api/agents/catalog",
        "https://retry-a.bridge.test/api/tasks",
      ]);

      bindNewTaskScreen(controller, replacement.manager, context("retry-b"), settings.getState());
      expect(await submit()).toBe("started");
      expect(replacement.requests).toEqual([
        {
          url: "https://retry-b.bridge.test/api/tasks",
          authorization: "Bearer token-retry-b",
          method: "POST",
        },
      ]);
      expect(navigation).toEqual(["back"]);
      expect(controller.state.draft.text).toBe("");
    } finally {
      first.manager.stop();
      replacement.manager.stop();
    }
  });

  test("a binding made before connected uses the manager facade after it connects", async () => {
    const settings = createSettingsStore(createMemoryStorage());
    const harness = managerHarness("early-binding");
    const taskContext = context("early-binding");
    const controller = new NewTaskController(unavailableNewTaskPort, taskContext, {
      project: { kind: "existing", id: "sp1" },
    });
    const calls = harness.manager.calls();

    bindNewTaskScreen(controller, harness.manager, taskContext, settings.getState());
    expect(harness.requests).toEqual([]);
    await connect(harness.manager, harness.socket);

    try {
      expect(harness.manager.calls()).toBe(calls);
      await controller.load();
      controller.setText("Wait for the connection");
      expect(await controller.go()).toBe("started");
      expect(harness.requests).toEqual([
        {
          url: "https://early-binding.bridge.test/api/agents/catalog",
          authorization: "Bearer token-early-binding",
          method: "GET",
        },
        {
          url: "https://early-binding.bridge.test/api/tasks",
          authorization: "Bearer token-early-binding",
          method: "POST",
        },
      ]);
    } finally {
      harness.manager.stop();
    }
  });

  test("a missing manager binds the unavailable calls fallback", async () => {
    const settings = createSettingsStore(createMemoryStorage());
    const taskContext = context("offline");
    const controller = new NewTaskController(unavailableNewTaskPort, taskContext, {
      project: { kind: "existing", id: "sp1" },
    });

    bindNewTaskScreen(controller, undefined, taskContext, settings.getState());
    await controller.load();

    expect(controller.state.catalog).toBeUndefined();
    expect(controller.state.catalogError).toContain("Not connected to the selected Mac.");
  });
});

interface CapturedRequest {
  url: string;
  authorization: string | null;
  method: string;
}

function managerHarness(id: string, options: { failStarts?: boolean } = {}) {
  const machine: Machine = {
    id,
    name: id,
    routes: { secure: { url: `https://${id}.bridge.test`, key: `${id}-bridge-key` } },
    role: "control",
    deviceId: `device-${id}`,
  };
  const requests: CapturedRequest[] = [];
  const socket = new FakeSocket({ machine });
  const manager = createConnectionManager({
    machine,
    secrets: createMemorySecrets([[machine.id, `token-${id}`]]),
    core: createCoreStore().getState(),
    openRoute: () =>
      routeConnection(socket, async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("Authorization"),
          method,
        });
        const path = new URL(url).pathname;
        if (path === "/api/agents/catalog") return Response.json(taskCatalog());
        if (path === "/api/tasks" && method === "POST") {
          if (options.failStarts) {
            return Response.json(
              { error: "start_failed", message: "The first manager rejected the start." },
              { status: 503 },
            );
          }
          const request = JSON.parse(String(init?.body)) as StartTaskRequest;
          return Response.json(acceptedReply(request));
        }
        return Response.json(
          { error: "not_found", message: "No fake response for this path." },
          {
            status: 404,
          },
        );
      }),
    clock: new FakeClock(),
  });
  return { manager, machine, requests, socket };
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

function startRequest(): StartTaskRequest {
  return {
    text: "Not sent after stop",
    run: { kind: "program", id: "claude" },
    folder: "/Users/roy/project",
    space: { kind: "existing", id: "sp1" },
  };
}

function acceptedReply(request: StartTaskRequest): StartTaskReply {
  const spaceId = request.space.kind === "existing" ? request.space.id : "created-space";
  const record: TaskRecord = {
    id: `tk${"1".repeat(32)}`,
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
