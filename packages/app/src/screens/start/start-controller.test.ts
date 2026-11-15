/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  AgentCatalog,
  Layout,
  StartAgentReply,
  StartAgentRequest,
  Terminal,
} from "@herdr-mobile/protocol";
import { deriveSpaces } from "../../model/spaces.ts";
import { newTabTarget, type SpaceTargetId } from "../../model/spaceTarget.ts";
import { deriveStartOptions } from "../../model/startAgent.ts";
import { BridgeApiError } from "../../net/bridge-api.ts";
import { createNewTab } from "../spaces/newItems.ts";
import {
  createStartController,
  dispatchStartAction,
  type StartAgentPort,
  type StartController,
} from "./start-controller.ts";

describe("start controller", () => {
  test("loads choices, starts the validated draft, and opens the returned agent", async () => {
    const port = fakePort();
    const controller = createStartController(port.value, "sp1");

    await controller.load();
    controller.applyOptions(deriveStartOptions(catalog(), layout(), [terminal()], [], "sp1"));
    controller.set("task", "Fix the failing test");
    const started = await controller.start();

    expect(started).toBe(true);
    expect(port.calls.start).toEqual([
      {
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "existing", id: "sp1" },
        task: "Fix the failing test",
      },
    ]);
    expect(port.calls.haptic).toBe(1);
    expect(port.calls.openAgent).toEqual([{ address: "t1", placement: "window" }]);
    expect(port.calls.openSpaces).toEqual([]);
    expect(controller.state.status).toBe("done");
  });

  test("keeps the form open with field errors when the draft is invalid", async () => {
    const port = fakePort();
    const controller = createStartController(port.value);
    await controller.load();
    controller.set("folder", "../project");

    expect(await controller.start()).toBe(false);
    expect(controller.state).toMatchObject({
      status: "editing",
      fieldErrors: {
        space: "Choose a space.",
        folder: "Enter an absolute path or a path starting with ~/.",
      },
    });
    expect(port.calls.start).toEqual([]);
  });

  test("keeps bridge folder errors inline and permits a retry", async () => {
    let attempts = 0;
    const port = fakePort({
      start: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new BridgeApiError(422, "folder_missing", "That folder no longer exists.");
        }
        return reply();
      },
    });
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(deriveStartOptions(catalog(), layout(), [terminal()], [], "sp1"));

    expect(await controller.start()).toBe(false);
    expect(controller.state).toMatchObject({
      status: "error",
      error: "That folder no longer exists.",
      fieldErrors: { folder: "That folder no longer exists." },
    });
    expect(port.calls.haptic).toBe(0);
    expect(await controller.start()).toBe(true);
    expect(attempts).toBe(2);
    expect(controller.state.status).toBe("done");
  });

  test("falls back to built-ins after a catalog error and opens Spaces without an address", async () => {
    const port = fakePort({
      catalog: async () => {
        throw new Error("catalog unavailable");
      },
      start: async () => ({
        placement: "core",
        space: { id: "sp-new", isNew: true },
        tab: { id: "tb-new", isNew: true },
      }),
    });
    const controller = createStartController(port.value);
    await controller.load();
    controller.applyOptions(deriveStartOptions(undefined, undefined, [], [], undefined));
    controller.set("folder", "/Users/roy/project");

    expect(controller.state).toMatchObject({
      status: "editing",
      catalogError: "catalog unavailable",
    });
    expect(await controller.start()).toBe(true);
    expect(port.calls.openAgent).toEqual([]);
    expect(port.calls.openSpaces).toEqual([{ spaceId: "sp-new", placement: "core" }]);
  });

  test("does not let Refresh unlock a pending start or allow a second request", async () => {
    let resolveStart: ((value: StartAgentReply) => void) | undefined;
    let catalogCalls = 0;
    const port = fakePort({
      catalog: async () => {
        catalogCalls += 1;
        return { ...catalog(), templatesError: "Templates are temporarily unavailable." };
      },
      start: () => new Promise((resolve) => (resolveStart = resolve)),
    });
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );

    const pendingStart = controller.start();
    expect(controller.state.status).toBe("starting");
    await controller.load();

    expect(controller.state.status).toBe("starting");
    expect(catalogCalls).toBe(1);
    expect(await controller.start()).toBe(false);
    expect(port.calls.start).toHaveLength(1);

    resolveStart?.(reply());
    expect(await pendingStart).toBe(true);
    expect(controller.state.status).toBe("done");
    await controller.load();
    expect(controller.state.status).toBe("done");
    expect(catalogCalls).toBe(1);
  });

  test("reconciles a hidden run after a failed Refresh before allowing submission", async () => {
    let catalogCalls = 0;
    const port = fakePort({
      catalog: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          return {
            ...catalog(),
            programs: ["claude", "codex", "printf"],
            templatesError: "Templates are temporarily unavailable.",
          };
        }
        throw new Error("catalog unavailable");
      },
    });
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );
    controller.set("run", { kind: "program", id: "printf" });

    await controller.load();
    const fallbackOptions = deriveStartOptions(undefined, layout(), [terminal()], [], "sp1");
    controller.applyOptions(fallbackOptions);

    expect(fallbackOptions.runChoices.map((choice) => choice.selection)).toContainEqual({
      kind: "program",
      id: "claude",
    });
    expect(controller.state.draft.run).toEqual({ kind: "program", id: "claude" });
    controller.set("run", { kind: "program", id: "printf" });
    expect(await controller.start()).toBe(false);
    expect(port.calls.start).toEqual([]);
    controller.set("run", { kind: "program", id: "claude" });
    expect(await controller.start()).toBe(true);
    expect(port.calls.start[0]?.run).toEqual({ kind: "program", id: "claude" });
    expect(port.calls.start[0]?.run).not.toEqual({ kind: "program", id: "printf" });
  });

  test("refreshes a removed run after run_not_allowed and keeps the rest of the draft", async () => {
    let catalogCalls = 0;
    let startCalls = 0;
    const port = fakePort({
      catalog: async () => {
        catalogCalls += 1;
        return catalogCalls === 1
          ? { ...catalog(), templates: [{ name: "review", description: "Review changes" }] }
          : catalog();
      },
      start: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          throw new BridgeApiError(422, "run_not_allowed", "That template is no longer available.");
        }
        return reply();
      },
    });
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );
    controller.set("run", { kind: "template", name: "review" });
    controller.set("task", "Keep this first message");

    expect(await controller.start()).toBe(false);
    expect(controller.state).toMatchObject({
      status: "error",
      error: "That template is no longer available.",
      refreshAvailable: true,
    });
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );

    expect(controller.state).toMatchObject({
      draft: {
        run: { kind: "program", id: "claude" },
        folder: "/Users/roy/project",
        space: { kind: "existing", id: "sp1" },
        task: "Keep this first message",
      },
      refreshAvailable: false,
    });
    expect(await controller.start()).toBe(true);
    expect(port.calls.start[1]).toEqual({
      run: { kind: "program", id: "claude" },
      folder: "/Users/roy/project",
      space: { kind: "existing", id: "sp1" },
      task: "Keep this first message",
    });
  });

  test("refreshes a closed-window refusal and retries the same first message", async () => {
    let catalogCalls = 0;
    let startCalls = 0;
    const port = fakePort({
      catalog: async () => {
        catalogCalls += 1;
        return { ...catalog(), windowOpen: catalogCalls > 1 };
      },
      start: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          throw new BridgeApiError(
            422,
            "run_not_allowed",
            "Open Herdr or leave the first message empty.",
          );
        }
        return reply();
      },
    });
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );
    controller.set("task", "Keep this first message");

    expect(await controller.start()).toBe(false);
    expect(controller.state).toMatchObject({
      error: "Open Herdr or leave the first message empty.",
      refreshAvailable: true,
      draft: { task: "Keep this first message" },
    });
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
    );

    expect(controller.state.catalog?.windowOpen).toBe(true);
    expect(controller.state.draft).toMatchObject({
      run: { kind: "program", id: "claude" },
      task: "Keep this first message",
    });
    expect(await controller.start()).toBe(true);
    expect(port.calls.start[1]?.task).toBe("Keep this first message");
  });

  test("passes both placement values through address navigation", async () => {
    for (const placement of ["core", "window"] as const) {
      const port = fakePort({ start: async () => ({ ...reply(), placement }) });
      const controller = createStartController(port.value, "sp1");
      await controller.load();
      controller.applyOptions(
        deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
      );

      expect(await controller.start()).toBe(true);
      expect(port.calls.openAgent).toEqual([{ address: "t1", placement }]);
      expect(port.calls.openSpaces).toEqual([]);
    }
  });

  test("passes both placement values through Spaces navigation when no address is returned", async () => {
    for (const placement of ["core", "window"] as const) {
      const port = fakePort({
        start: async () => ({
          placement,
          space: { id: "sp-new", isNew: true },
          tab: { id: "tb-new", isNew: true },
        }),
      });
      const controller = createStartController(port.value);
      await controller.load();
      controller.applyOptions(deriveStartOptions(undefined, undefined, [], [], undefined));
      controller.set("folder", "/Users/roy/project");

      expect(await controller.start()).toBe(true);
      expect(port.calls.openSpaces).toEqual([{ spaceId: "sp-new", placement }]);
      expect(port.calls.openAgent).toEqual([]);
    }
  });

  test("preserves the preselection when the layout arrives during the first catalog load", async () => {
    const terminals = [terminal("t1", "sp1"), terminal("t2", "sp2")];
    let resolveCatalog: ((value: AgentCatalog) => void) | undefined;
    const port = fakePort({
      catalog: () => new Promise((resolve) => (resolveCatalog = resolve)),
    });
    const controller = createStartController(port.value, "sp1");
    const loading = controller.load();

    const labelOptions = deriveStartOptions(undefined, undefined, terminals, [], "sp1");
    expect(labelOptions.runChoices.some((choice) => choice.kind === "empty")).toBe(true);
    controller.applyOptions(labelOptions);
    expect(controller.state.draft).toEqual({
      run: undefined,
      folder: "",
      space: undefined,
      task: "",
    });
    expect(await controller.start()).toBe(false);
    expect(port.calls.start).toEqual([]);

    const reorderedLayout = twoSpaceLayout(["sp2", "sp1"]);
    const layoutOptions = deriveStartOptions(undefined, reorderedLayout, terminals, [], "sp1");
    controller.applyOptions(layoutOptions);
    resolveCatalog?.(catalog());
    await loading;

    const options = deriveStartOptions(
      controller.state.catalog,
      reorderedLayout,
      terminals,
      [],
      "sp1",
    );
    controller.applyOptions(options);
    expect(options.runChoices.some((choice) => choice.kind === "empty")).toBe(true);
    expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp1" });
    controller.set("run", { kind: "empty" });

    const emptyTab = emptyTabHarness(controller, targetFor("sp1", terminals, reorderedLayout));
    const result = await dispatchStartAction(controller.state.draft.run, {
      start: () => controller.start(),
      createEmptyTab: emptyTab.createEmptyTab,
    });

    expect(result).toEqual({ ok: true });
    expect(emptyTab.calls).toEqual([{ action: "tab.new", args: { space: "sp1" } }]);
    expect(port.calls.start).toEqual([]);
  });

  test("selects the preselected target when catalog results arrive before space rows", async () => {
    const terminals = [terminal("t1", "sp1"), terminal("t2", "sp2")];
    const controller = createStartController(fakePort().value, "sp1");
    await controller.load();

    const emptyOptions = deriveStartOptions(controller.state.catalog, undefined, [], [], "sp1");
    controller.applyOptions(emptyOptions);
    expect(emptyOptions.spaceChoices).toEqual([{ selection: { kind: "new" }, name: "New space" }]);
    expect(controller.state.draft.space).toEqual({ kind: "new" });

    const labelOptions = deriveStartOptions(
      controller.state.catalog,
      undefined,
      terminals,
      [],
      "sp1",
    );
    controller.applyOptions(labelOptions);
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp1" },
      folder: "/Users/roy/project/src",
    });

    const layoutOptions = deriveStartOptions(
      controller.state.catalog,
      twoSpaceLayout(["sp2", "sp1"]),
      terminals,
      [],
      "sp1",
    );
    controller.applyOptions(layoutOptions);
    expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp1" });
    expect(layoutOptions.runChoices.some((choice) => choice.kind === "empty")).toBe(true);
  });

  test("keeps label-backed Empty tab available through a refresh when layout never arrives", async () => {
    const terminals = [terminal()];
    const port = fakePort();
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, undefined, terminals, [], "sp1"),
    );

    await controller.load();
    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, undefined, terminals, [], "sp1"),
    );
    expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp1" });
    expect(controller.state.draft.run).toEqual({ kind: "program", id: "claude" });
    expect(
      deriveStartOptions(controller.state.catalog, undefined, terminals, [], "sp1").runChoices.some(
        (choice) => choice.kind === "empty",
      ),
    ).toBe(true);

    controller.set("run", { kind: "empty" });
    const emptyTab = emptyTabHarness(
      controller,
      targetFor("label-space:sp1", terminals, undefined),
    );
    const result = await dispatchStartAction(controller.state.draft.run, {
      start: () => controller.start(),
      createEmptyTab: emptyTab.createEmptyTab,
    });

    expect(result).toEqual({ ok: true });
    expect(emptyTab.calls).toEqual([{ action: "tab.new", args: { space: "sp1" } }]);
    expect(port.calls.start).toEqual([]);
  });

  test("keeps the target, task, and typed folder through layout reorder and fallback", async () => {
    const terminals = [terminal("t1", "sp1"), terminal("t2", "sp2")];
    const controller = createStartController(fakePort().value, "sp1");
    await controller.load();
    controller.applyOptions(
      deriveStartOptions(
        controller.state.catalog,
        twoSpaceLayout(["sp1", "sp2"]),
        terminals,
        [],
        "sp1",
      ),
    );
    controller.set("task", "Keep this task");
    controller.set("folder", "/Users/roy/custom-folder");

    for (const layoutValue of [twoSpaceLayout(["sp2", "sp1"]), undefined]) {
      const options = deriveStartOptions(
        controller.state.catalog,
        layoutValue,
        terminals,
        [],
        "sp1",
      );
      controller.applyOptions(options);
      expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp1" });
      expect(options.runChoices.some((choice) => choice.kind === "empty")).toBe(true);
    }

    expect(controller.state.draft).toMatchObject({
      task: "Keep this task",
      folder: "/Users/roy/custom-folder",
    });
  });

  test("reconciles automatic folders after space selection, late metadata, and fallback", async () => {
    const port = fakePort();
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    const terminals = [terminal()];
    controller.applyOptions(
      deriveStartOptions(
        controller.state.catalog,
        twoSpaceLayoutWithSp2Folder(undefined),
        terminals,
        [],
        "sp1",
      ),
    );

    // This is the StartScreen.selectSpace controller call after folder policy moved here.
    controller.set("space", { kind: "existing", id: "sp2" });
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp2" },
      folder: "",
    });

    controller.applyOptions(
      deriveStartOptions(
        controller.state.catalog,
        twoSpaceLayoutWithSp2Folder("/tmp/sp2"),
        terminals,
        [],
        "sp1",
      ),
    );
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp2" },
      folder: "/tmp/sp2",
    });

    controller.applyOptions(
      deriveStartOptions(controller.state.catalog, layout(), terminals, [], "sp1"),
    );
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp1" },
      folder: "/Users/roy/project",
    });
  });

  test("preserves a typed folder across space-list updates and refresh", async () => {
    const port = fakePort();
    const controller = createStartController(port.value, "sp1");
    await controller.load();
    const terminals = [terminal()];
    controller.applyOptions(
      deriveStartOptions(
        controller.state.catalog,
        twoSpaceLayoutWithSp2Folder("/Users/roy/research"),
        terminals,
        [],
        "sp1",
      ),
    );
    controller.set("space", { kind: "existing", id: "sp2" });
    controller.set("folder", "/Users/roy/custom-folder");

    const fallbackOptions = deriveStartOptions(
      controller.state.catalog,
      layout(),
      terminals,
      [],
      "sp1",
    );
    controller.applyOptions(fallbackOptions);
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp1" },
      folder: "/Users/roy/custom-folder",
    });

    await controller.load();
    controller.applyOptions(fallbackOptions);
    expect(controller.state.draft).toMatchObject({
      space: { kind: "existing", id: "sp1" },
      folder: "/Users/roy/custom-folder",
    });
  });

  test("keeps a user-selected space across refresh and ignores space changes while loading", async () => {
    let catalogCalls = 0;
    let resolveRefresh: ((value: AgentCatalog) => void) | undefined;
    const port = fakePort({
      catalog: () => {
        catalogCalls += 1;
        return catalogCalls === 1
          ? Promise.resolve(catalog())
          : new Promise((resolve) => (resolveRefresh = resolve));
      },
    });
    const controller = createStartController(port.value, "sp1");
    controller.set("space", { kind: "existing", id: "sp2" });
    expect(controller.state.draft.space).toBeUndefined();

    await controller.load();
    const terminals = [terminal("t1", "sp1"), terminal("t2", "sp2")];
    controller.applyOptions(
      deriveStartOptions(
        controller.state.catalog,
        twoSpaceLayout(["sp1", "sp2"]),
        terminals,
        [],
        "sp1",
      ),
    );
    controller.set("space", { kind: "existing", id: "sp2" });

    const refresh = controller.load();
    const reorderedOptions = deriveStartOptions(
      controller.state.catalog,
      twoSpaceLayout(["sp2", "sp1"]),
      terminals,
      [],
      "sp1",
    );
    controller.applyOptions(reorderedOptions);
    expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp2" });
    resolveRefresh?.(catalog());
    await refresh;
    controller.applyOptions(reorderedOptions);

    expect(controller.state.draft.space).toEqual({ kind: "existing", id: "sp2" });
    expect(reorderedOptions.runChoices.some((choice) => choice.kind === "empty")).toBe(true);
  });

  test("refuses agent starts for watch devices and offline Macs without changing the draft", async () => {
    for (const access of [
      { role: "watch" as const, connected: true },
      { role: "control" as const, connected: false },
    ]) {
      const port = fakePort();
      const controller = createStartController(port.value, "sp1");
      await controller.load();
      controller.applyOptions(
        deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
      );
      controller.set("task", "Keep this draft");
      controller.setAccess(access.role, access.connected);
      const draft = controller.state.draft;

      expect(await controller.start()).toBe(false);
      expect(controller.state.draft).toEqual(draft);
      expect(controller.state.status).toBe("editing");
      expect(port.calls.start).toEqual([]);
      expect(port.calls.openAgent).toEqual([]);
      expect(port.calls.openSpaces).toEqual([]);
    }
  });

  test("dispatches Empty tab through createNewTab with a resolved target and no start", async () => {
    const space = deriveSpaces([terminal()], undefined)[0]?.spaces[0];
    if (!space) throw new Error("Expected a label-backed space");
    const target = newTabTarget(space, undefined);
    if (!target) throw new Error("Expected a resolved label target");

    const port = fakePort();
    const appDoCalls: Array<{ action: string; args?: Record<string, unknown> }> = [];
    const dependencies = {
      calls: {
        appDo: async (action: "space.new" | "tab.new", args?: Record<string, unknown>) => {
          appDoCalls.push({ action, args });
        },
      },
    };
    const machine = { id: "machine", role: "control" as const };
    const controller = createStartController(port.value);
    const createEmptyTab = () =>
      controller.createEmptyTabIfAllowed(target, (resolvedTarget) =>
        createNewTab(dependencies, machine, resolvedTarget),
      );

    const result = await dispatchStartAction(
      { kind: "empty" },
      {
        start: () =>
          port.value.start({
            run: { kind: "program", id: "claude" },
            folder: "/repo",
            space: { kind: "existing", id: "sp1" },
          }),
        createEmptyTab,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(appDoCalls).toEqual([{ action: "tab.new", args: { space: "sp1" } }]);
    expect(port.calls.start).toEqual([]);
  });

  test("keeps Empty tab creation available for retry after failure", async () => {
    const space = deriveSpaces([terminal()], undefined)[0]?.spaces[0];
    if (!space) throw new Error("Expected a label-backed space");
    const target = newTabTarget(space, undefined);
    if (!target) throw new Error("Expected a resolved label target");

    let attempts = 0;
    const controller = createStartController(fakePort().value);
    const createEmptyTab = () =>
      controller.createEmptyTabIfAllowed(target, async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, message: "Couldn't create the tab." } : { ok: true };
      });
    const start = async () => {
      throw new Error("Empty tab must not start an agent");
    };

    expect(await dispatchStartAction({ kind: "empty" }, { start, createEmptyTab })).toEqual({
      ok: false,
      message: "Couldn't create the tab.",
    });
    expect(await dispatchStartAction({ kind: "empty" }, { start, createEmptyTab })).toEqual({
      ok: true,
    });
    expect(attempts).toBe(2);
  });

  test("keeps Empty tab dispatch idle for watch-only and offline devices", async () => {
    const space = deriveSpaces([terminal()], undefined)[0]?.spaces[0];
    if (!space) throw new Error("Expected a label-backed space");
    const target = newTabTarget(space, undefined);
    if (!target) throw new Error("Expected a resolved label target");
    let createCalls = 0;
    for (const access of [
      { role: "watch" as const, connected: true },
      { role: "control" as const, connected: false },
    ]) {
      const port = fakePort();
      const controller = createStartController(port.value, "sp1");
      await controller.load();
      controller.applyOptions(
        deriveStartOptions(controller.state.catalog, layout(), [terminal()], [], "sp1"),
      );
      controller.set("task", "Keep this draft");
      const draft = controller.state.draft;
      controller.setAccess(access.role, access.connected);
      const createEmptyTab = () =>
        controller.createEmptyTabIfAllowed(target, async () => {
          createCalls += 1;
          return { ok: true };
        });

      expect(
        await dispatchStartAction(
          { kind: "empty" },
          {
            start: () => controller.start(),
            createEmptyTab,
          },
        ),
      ).toBeUndefined();
      expect(controller.state.draft).toEqual(draft);
      expect(port.calls.start).toEqual([]);
    }

    expect(createCalls).toBe(0);
  });
});

function fakePort(overrides: Partial<StartAgentPort> = {}) {
  const calls = {
    start: [] as StartAgentRequest[],
    haptic: 0,
    openAgent: [] as { address: string; placement: "window" | "core" }[],
    openSpaces: [] as { spaceId: string | undefined; placement: "window" | "core" | undefined }[],
  };
  const value: StartAgentPort = {
    catalog: async () => (overrides.catalog ? overrides.catalog() : catalog()),
    start: async (request) => {
      calls.start.push(request);
      return overrides.start ? overrides.start(request) : reply();
    },
    openAgent: (address, placement) => calls.openAgent.push({ address, placement }),
    openSpaces: (spaceId, placement) => calls.openSpaces.push({ spaceId, placement }),
    haptic:
      overrides.haptic ??
      (() => {
        calls.haptic += 1;
      }),
  };
  return { value, calls };
}

function catalog(): AgentCatalog {
  return {
    programs: ["claude", "codex"],
    templates: [],
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

function twoSpaceLayout(spaceIds: readonly ("sp1" | "sp2")[]): Layout {
  return {
    spaces: spaceIds.map((id) => ({
      id,
      name: id === "sp1" ? "Work" : "Research",
      folder: id === "sp1" ? "/Users/roy/project" : "/Users/roy/research",
      tabs: [
        {
          id: `tb-${id}`,
          name: "Main",
          terminalAddresses: [id === "sp1" ? "t1" : "t2"],
        },
      ],
    })),
  };
}

function twoSpaceLayoutWithSp2Folder(sp2Folder: string | undefined): Layout {
  return {
    spaces: [
      {
        id: "sp1",
        name: "Work",
        folder: "/Users/roy/project",
        tabs: [{ id: "tb-sp1", name: "Main", terminalAddresses: ["t1"] }],
      },
      {
        id: "sp2",
        name: "Research",
        folder: sp2Folder ?? null,
        tabs: [{ id: "tb-sp2", name: "Main", terminalAddresses: [] }],
      },
    ],
  };
}

function terminal(address = "t1", spaceId = "sp1"): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: spaceId === "sp1" ? "/Users/roy/project/src" : `/Users/roy/${spaceId}/src`,
    labels: { "herdr.space": spaceId },
    rows: 24,
    screen: "exact",
    state: "live",
  };
}

function targetFor(
  spaceId: string,
  terminals: readonly Terminal[],
  layoutValue: Layout | undefined,
): SpaceTargetId {
  const space = deriveSpaces(terminals, layoutValue)
    .flatMap((group) => group.spaces)
    .find((row) => row.id === spaceId);
  if (!space) throw new Error(`Expected a row for ${spaceId}`);
  const target = newTabTarget(space, layoutValue);
  if (!target) throw new Error(`Expected a target for ${spaceId}`);
  return target;
}

function emptyTabHarness(controller: StartController, target: SpaceTargetId) {
  const calls: Array<{ action: string; args?: Record<string, unknown> }> = [];
  const dependencies = {
    calls: {
      appDo: async (action: "space.new" | "tab.new", args?: Record<string, unknown>) => {
        calls.push({ action, args });
      },
    },
  };
  const machine = { id: "machine", role: "control" as const };

  return {
    calls,
    createEmptyTab: () =>
      controller.createEmptyTabIfAllowed(target, (resolvedTarget) =>
        createNewTab(dependencies, machine, resolvedTarget),
      ),
  };
}

function reply(): StartAgentReply {
  return {
    placement: "window",
    address: "t1",
    space: { id: "sp1", isNew: false },
    tab: { id: "tb2", isNew: true },
  };
}
