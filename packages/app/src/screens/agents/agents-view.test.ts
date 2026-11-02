/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import { deriveAgents } from "../../model/agents.ts";
import { createCoreStore } from "../../store/core.ts";
import { createMachinesStore, type Machine } from "../../store/machines.ts";
import { createMemorySecrets, createMemoryStorage } from "../../store/memory.ts";
import { createSeenStore } from "../../store/seen.ts";
import { createSettingsStore } from "../../store/settings.ts";
import {
  blockedQuestionCallout,
  connectionPresentation,
  deriveAgentSections,
  findAgent,
  flattenAgentSections,
  matchesAgentSearch,
  selectActiveAgentMachine,
  startAgentAgeRefresh,
  toggleAgentSort,
} from "./agents-view.ts";

const agent = {
  title: "pricing page",
  space: "website",
  program: { name: "Claude Code" },
};

describe("matchesAgentSearch", () => {
  test("matches title, space, and program without matching unrelated fields", () => {
    expect(matchesAgentSearch(agent, "PRICING")).toBe(true);
    expect(matchesAgentSearch(agent, "website")).toBe(true);
    expect(matchesAgentSearch(agent, "claude")).toBe(true);
    expect(matchesAgentSearch(agent, "terminal-address")).toBe(false);
  });

  test("trims the query and treats an empty query as no filter", () => {
    expect(matchesAgentSearch(agent, "  website  ")).toBe(true);
    expect(matchesAgentSearch(agent, "  ")).toBe(true);
  });
});

describe("Agents screen decisions", () => {
  test("selects the active machine and scopes seen turns to that machine", () => {
    const storage = createMemoryStorage();
    const machines = createMachinesStore(storage, createMemorySecrets());
    machines.getState().addMachine(machine("mac-a", "Mac A"));
    machines.getState().addMachine(machine("mac-b", "Mac B"));
    const core = createCoreStore();
    core.getState().setSnapshot("mac-a", [doneTerminal("t1")], 10);
    core.getState().setSnapshot("mac-b", [doneTerminal("t1")], 10);
    const seen = createSeenStore(storage);
    seen.getState().mark("mac-a", "t1", 1);

    const selectedA = selectActiveAgentMachine(
      machines.getState().activeId,
      machines.getState().machines,
      core.getState().machines,
      emptyCore(),
    );
    const rowsA = deriveAgentSections(
      machines.getState().activeId,
      selectedA.core,
      seen.getState().seen,
      20_000,
      "priority",
      undefined,
    );
    expect(selectedA.machine?.name).toBe("Mac A");
    expect(rowsA.allSections[0]?.agents[0]?.state).toBe("idle");

    machines.getState().setActiveId("mac-b");
    const selectedB = selectActiveAgentMachine(
      machines.getState().activeId,
      machines.getState().machines,
      core.getState().machines,
      emptyCore(),
    );
    const rowsB = deriveAgentSections(
      machines.getState().activeId,
      selectedB.core,
      seen.getState().seen,
      20_000,
      "priority",
      undefined,
    );
    expect(selectedB.machine?.name).toBe("Mac B");
    expect(rowsB.allSections[0]?.agents[0]?.state).toBe("done");
  });

  test("toggles sort and persists the choice through the settings store", async () => {
    const storage = createMemoryStorage();
    const settings = createSettingsStore(storage);
    const next = toggleAgentSort("priority", settings.getState().setAgentSort);
    expect(next).toBe("space");

    const restored = createSettingsStore(storage);
    await restored.persist.rehydrate();
    expect(restored.getState().agents.sort).toBe("space");
  });

  test("refreshes age labels every 30 seconds and clears the interval", () => {
    const timer = 17 as unknown as ReturnType<typeof setInterval>;
    let callback: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    let cancelledTimer: ReturnType<typeof setInterval> | undefined;
    let refreshes = 0;
    const stop = startAgentAgeRefresh(
      () => refreshes++,
      (next, milliseconds) => {
        callback = next;
        scheduledDelay = milliseconds;
        return timer;
      },
      (scheduledTimer) => {
        cancelledTimer = scheduledTimer;
      },
    );

    expect(scheduledDelay).toBe(30_000);
    callback?.();
    expect(refreshes).toBe(1);
    stop();
    expect(cancelledTimer).toBe(timer);
  });

  test("shows the separate blocked question only in priority rows", () => {
    const blocked = {
      ...doneTerminal("t1"),
      status: { state: "blocked", msg: "Allow this command?" },
    };
    const priority = deriveAgents([blocked], undefined, {}, "mac-a", 20_000, "priority", undefined);
    const bySpace = deriveAgents([blocked], undefined, {}, "mac-a", 20_000, "space", undefined);
    const priorityRow = priority[0]?.agents[0];
    const bySpaceRow = bySpace[0]?.agents[0];

    expect(priorityRow?.subtitle).toBe("Other · Claude Code");
    expect(
      blockedQuestionCallout("priority", priorityRow?.state ?? "idle", priorityRow?.question),
    ).toBe("Allow this command?");
    expect(bySpaceRow?.subtitle).toBe("Claude Code · Allow this command?");
    expect(
      blockedQuestionCallout("space", bySpaceRow?.state ?? "idle", bySpaceRow?.question),
    ).toBeUndefined();
    expect(blockedQuestionCallout("priority", "working", "Allow this command?")).toBeUndefined();
    expect(blockedQuestionCallout("priority", "blocked", undefined)).toBeUndefined();
  });

  test("flattens grouped sections into ordered, independently renderable rows", () => {
    const sections = deriveAgents(
      [
        doneTerminal("t1"),
        { ...doneTerminal("t2"), status: { state: "blocked", msg: "Allow?" } },
        { ...doneTerminal("t3"), status: { state: "blocked", msg: "Continue?" } },
        { ...doneTerminal("t4"), status: { state: "blocked", msg: "Trust?" } },
        { ...doneTerminal("t5"), status: { state: "working" } },
      ],
      undefined,
      {},
      "mac-a",
      20_000,
      "priority",
      undefined,
    );
    const entries = flattenAgentSections(sections);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "header",
      "row",
      "row",
      "row",
      "header",
      "row",
      "header",
      "row",
    ]);
    expect(
      entries.filter((entry) => entry.kind === "header").map(({ section }) => section.label),
    ).toEqual(["Needs you", "Done", "Working"]);
    expect(entries.filter((entry) => entry.kind === "row").map(({ position }) => position)).toEqual(
      ["first", "middle", "last", "only", "only"],
    );
    expect(findAgent(sections, "t2")?.address).toBe("t2");
    expect(findAgent(sections, undefined)).toBeUndefined();
  });

  for (const state of [
    "connecting",
    "connected",
    "reconnecting",
    "offline",
    "unauthorized",
  ] as const) {
    test(`derives ${state} presentation with and without cached rows`, () => {
      const cold = connectionPresentation(state, false, "MacBook Pro");
      const cached = connectionPresentation(state, true, "MacBook Pro");
      expect(cold.dimCachedRows).toBe(false);
      expect(cached.dimCachedRows).toBe(state !== "connected");

      if (state === "connected") {
        expect(cold.banner).toBeUndefined();
        expect(cached.banner).toBeUndefined();
        return;
      }

      if (state === "connecting") {
        expect(cold.banner).toMatchObject({
          kind: "reconnecting",
          message: "Connecting to MacBook Pro…",
        });
        expect(cached.banner).toMatchObject({
          kind: "reconnecting",
          message: "Reconnecting to MacBook Pro…",
        });
        return;
      }

      if (state === "reconnecting") {
        expect(cold.banner).toMatchObject({
          kind: "reconnecting",
          message: "Reconnecting to MacBook Pro…",
        });
        expect(cached.banner).toMatchObject({
          kind: "reconnecting",
          message: "Reconnecting to MacBook Pro…",
        });
        return;
      }

      if (state === "offline") {
        expect(cold.banner).toMatchObject({
          kind: "offline",
          message: "Can't reach the bridge. Check that Tailscale is on.",
          action: "retry",
        });
        expect(cached.banner).toEqual(cold.banner);
        return;
      }

      expect(cold.banner).toMatchObject({
        kind: "unauthorized",
        message: "This device is no longer paired with MacBook Pro.",
        action: "pair",
      });
      expect(cached.banner).toEqual(cold.banner);
    });
  }
});

function machine(id: string, name: string): Machine {
  return {
    id,
    name,
    url: `https://${id}.tailnet.ts.net`,
    role: "control",
    deviceId: `device-${id}`,
  };
}

function doneTerminal(address: string): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: "/repo",
    labels: {},
    reported: true,
    rows: 24,
    screen: "exact",
    state: "live",
    status: { state: "done" },
    status_ms: 10,
    turn: 1,
  };
}

function emptyCore() {
  return { connection: "offline" as const, terminals: {}, layout: undefined, snapshotAt: null };
}
