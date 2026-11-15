/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { StartTaskRequest } from "@herdr-mobile/protocol";
import type { BridgeCalls } from "./bridge-calls.ts";
import { unavailableBridgeCalls } from "./bridge-calls.ts";
import type { ConnectionManager } from "./connection.ts";
import { createTaskActions } from "./task-actions.ts";

describe("TaskActions", () => {
  test("routes task records through BridgeCalls and terminal actions through the core manager", async () => {
    const bridgeCalls: { method: string; value: unknown }[] = [];
    const coreCalls: { method: string; params: unknown }[] = [];
    const effects: string[] = [];
    const bridge: BridgeCalls = {
      health: async () => ({}),
      devices: async () => [],
      revoke: async () => {},
      appLs: async () => ({}),
      appDo: async () => ({}),
      agentCatalog: async () => ({
        programs: [],
        templates: [],
        roots: [],
        home: "/",
        windowOpen: true,
      }),
      startAgent: async () => ({
        placement: "core",
        space: { id: "space", isNew: false },
        tab: { id: "tab", isNew: false },
      }),
      startTask: async (request) => {
        bridgeCalls.push({ method: "startTask", value: request });
        return {
          record: {
            id: `tk${"a".repeat(32)}`,
            origin: "phone",
            createdAt: 1,
          },
          start: {
            placement: "core",
            space: { id: "space", isNew: false },
            tab: { id: "tab", isNew: false },
          },
        };
      },
      checkTask: async (request) => {
        bridgeCalls.push({ method: "checkTask", value: request });
      },
      uncheckTask: async (request) => {
        bridgeCalls.push({ method: "uncheckTask", value: request });
      },
      linkTask: async (request) => {
        bridgeCalls.push({ method: "linkTask", value: request });
      },
      clearTasks: async (request) => {
        bridgeCalls.push({ method: "clearTasks", value: request });
      },
    };
    const manager = {
      async call(method: string, params: unknown) {
        coreCalls.push({ method, params });
        return {};
      },
    } as unknown as Pick<ConnectionManager, "call">;
    const actions = createTaskActions(manager, bridge, {
      confirm: async () => {
        effects.push("confirm");
        return true;
      },
      haptic: () => effects.push("haptic"),
      copy: async (value) => {
        effects.push(`copy:${value}`);
      },
    });
    const startRequest: StartTaskRequest = {
      text: "Review the task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { kind: "existing", id: "space" },
    };

    await actions.start(startRequest);
    await actions.check({ id: "tk", turn: 2 });
    await actions.uncheck({ id: "tk" });
    await actions.link({ id: "tk", terminal: "t7" });
    await actions.clear({ spaceId: "space" });
    await actions.stop("t7");
    await actions.followUp("t7", "continue", true);
    await actions.followUp("t7", "thanks", false);
    await actions.answer("t7", ["down", "enter"]);
    expect(await actions.confirm({ title: "Check off this task?" })).toBe(true);
    await actions.haptic();
    await actions.copy("t7");

    expect(bridgeCalls.map(({ method }) => method)).toEqual([
      "startTask",
      "checkTask",
      "uncheckTask",
      "linkTask",
      "clearTasks",
    ]);
    expect(coreCalls).toEqual([
      { method: "terminal.kill", params: { terminal: "t7" } },
      { method: "terminal.send", params: { terminal: "t7", text: "continue", force: true } },
      { method: "terminal.send", params: { terminal: "t7", text: "thanks" } },
      { method: "terminal.keys", params: { terminal: "t7", keys: ["down", "enter"] } },
    ]);
    expect(effects).toEqual(["confirm", "haptic", "copy:t7"]);
  });

  test("requires a manager for terminal actions but keeps bridge calls available", async () => {
    const bridge: BridgeCalls = {
      ...unavailableBridgeCalls("Not connected."),
      startTask: async () => ({
        record: { id: `tk${"a".repeat(32)}`, origin: "phone", createdAt: 1 },
        start: {
          placement: "core",
          space: { id: "space", isNew: false },
          tab: { id: "tab", isNew: false },
        },
      }),
    };
    const actions = createTaskActions(undefined, bridge, {
      confirm: async () => false,
      haptic: () => {},
      copy: async () => {},
    });

    const request: StartTaskRequest = {
      text: "Review the task",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { kind: "existing", id: "space" },
    };
    await expect(actions.start(request)).resolves.toMatchObject({
      record: { origin: "phone" },
    });
    await expect(Promise.resolve().then(() => actions.stop("t7"))).rejects.toThrow("Not connected");
  });
});
