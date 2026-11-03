/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import { ComposerController } from "./composer-controller.ts";
import {
  AgentActionController,
  AutoTakeoverController,
  markOpeningTurnSeen,
  OpeningSeenTracker,
  selectAgentCapabilities,
  selectAgentScreen,
} from "./screen-controller.ts";
import { SentController } from "./sent-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function finishedScreen(details: Partial<Terminal> = {}, phase: "closed" | "connected" = "closed") {
  const terminal: Terminal = {
    address: "t7",
    argv: ["claude"],
    cols: 80,
    created_ms: 100,
    cwd: "/work",
    labels: {},
    rows: 24,
    screen: "exact",
    state: "finished",
    ...details,
  };
  return selectAgentScreen({
    address: "t7",
    activeId: null,
    seen: {},
    now: 100,
    snapshot: { cols: 80, rows: [[]], cursor: { x: 0, y: 0, visible: false } },
    machineCore: {
      connection: "connected",
      terminals: { t7: terminal },
      layout: undefined,
      snapshotAt: 100,
    },
    attachment: { mode: "watching", phase },
  });
}

describe("agent screen controllers", () => {
  test("watch and control roles expose only their allowed controls", () => {
    expect(selectAgentCapabilities("watch")).toEqual({
      canControl: false,
      readOnly: true,
      showMoreMenu: false,
      showKeyBar: false,
      showPromptChoices: false,
    });
    expect(selectAgentCapabilities("control")).toEqual({
      canControl: true,
      readOnly: false,
      showMoreMenu: true,
      showKeyBar: true,
      showPromptChoices: true,
    });
  });

  test("selects terminal fallbacks and a connection banner from screen state", () => {
    const terminal: Terminal = {
      address: "t7",
      argv: ["bash"],
      cols: 80,
      created_ms: 100,
      cwd: "/work",
      labels: {},
      rows: 24,
      screen: "exact",
      state: "live",
    };
    const view = selectAgentScreen({
      address: "t7",
      activeId: "machine-1",
      machine: {
        id: "machine-1",
        name: "Mac",
        url: "https://machine.example.ts.net",
        role: "watch",
        deviceId: "phone",
      },
      machineCore: {
        connection: "connected",
        terminals: { t7: terminal },
        layout: undefined,
        snapshotAt: 100,
      },
      seen: {},
      now: 100,
      snapshot: { cols: 80, rows: [[]], cursor: { x: 0, y: 0, visible: true } },
      attachment: { mode: "watching", phase: "error" },
    });

    expect(view.title).toBe("Bash");
    expect(view.subtitle).toBe("Mac");
    expect(view.showBanner).toBe(true);
    expect(view.bannerMessage).toBe("The terminal stream is unavailable.");
    expect(view.disabled).toBe(true);
    expect(view.readOnly).toBe(true);
  });

  test("shows a pending Claude terminal's program and fallback space", () => {
    const terminal: Terminal = {
      address: "t7",
      argv: ["claude"],
      cols: 80,
      created_ms: 100,
      cwd: "/work",
      labels: {},
      rows: 24,
      screen: "exact",
      state: "live",
    };
    const view = selectAgentScreen({
      address: "t7",
      activeId: "machine-1",
      machine: {
        id: "machine-1",
        name: "Mac",
        url: "https://machine.example.ts.net",
        role: "watch",
        deviceId: "phone",
      },
      machineCore: {
        connection: "connected",
        terminals: { t7: terminal },
        layout: undefined,
        snapshotAt: 100,
      },
      seen: {},
      now: 100,
      snapshot: { cols: 80, rows: [[]], cursor: { x: 0, y: 0, visible: true } },
      attachment: { mode: "watching", phase: "error" },
    });

    expect(view.title).toBe("Claude Code");
    expect(view.subtitle).toBe("Other · Mac");
  });

  test("reports the exit code when a finished terminal stream closes", () => {
    expect(finishedScreen({ exit_code: 0, signal: 15 }).bannerMessage).toBe(
      "The program exited with code 0.",
    );
  });

  test("reports known signal names and unknown signal numbers for finished terminals", () => {
    for (const [signal, name] of [
      [1, "SIGHUP"],
      [2, "SIGINT"],
      [3, "SIGQUIT"],
      [9, "SIGKILL"],
      [15, "SIGTERM"],
    ] as const) {
      expect(finishedScreen({ signal }).bannerMessage).toBe(`The program was stopped by ${name}.`);
    }
    expect(finishedScreen({ signal: 6 }).bannerMessage).toBe(
      "The program was stopped by signal 6.",
    );
  });

  test("shows the generic ended message when a finished terminal has no exit details", () => {
    const view = finishedScreen({ reason: "server_stop" }, "connected");
    expect(view.bannerMessage).toBe("The program has ended.");
    expect(view.showBanner).toBe(true);
  });

  test("marks the opening turn once, then marks new machine or address openings", () => {
    const tracker = new OpeningSeenTracker();
    const marked: string[] = [];
    const record = (machineId: string, address: string, turn: number) => {
      marked.push(`${machineId}:${address}:${turn}`);
    };

    const mark = (machineId: string, address: string, turn: number) =>
      record(machineId, address, turn);
    markOpeningTurnSeen(tracker, "m1", "t7", 4, mark);
    markOpeningTurnSeen(tracker, "m1", "t7", 5, mark);
    markOpeningTurnSeen(tracker, "m1", "t8", 8, mark);
    markOpeningTurnSeen(tracker, "m2", "t8", 9, mark);

    expect(marked).toEqual(["m1:t7:4", "m1:t8:8", "m2:t8:9"]);
  });

  test("starts automatic takeover once after the route and connection are ready", () => {
    const controller = new AutoTakeoverController();
    const waiting = {
      requested: true,
      canControl: true,
      connected: false,
      fit: undefined,
    };
    expect(controller.shouldStart(waiting)).toBe(false);
    expect(
      controller.shouldStart({ ...waiting, connected: true, fit: { cols: 0, rows: 24 } }),
    ).toBe(false);
    expect(
      controller.shouldStart({ ...waiting, connected: true, fit: { cols: 80, rows: 0 } }),
    ).toBe(false);
    const ready = { ...waiting, connected: true, fit: { cols: 80, rows: 24 } };
    expect(controller.shouldStart(ready)).toBe(true);
    expect(controller.shouldStart(ready)).toBe(false);
  });

  test("captures action errors and clears them when the next action starts", async () => {
    const controller = new AgentActionController();
    const failed = await controller.run(async () => {
      throw new Error("bridge unavailable");
    });
    expect(failed).toEqual({ ok: false, error: "bridge unavailable" });
    expect(controller.getSnapshot().error).toBe("bridge unavailable");

    expect(await controller.run(async () => "ok")).toEqual({ ok: true, value: "ok" });
    expect(controller.getSnapshot().error).toBeUndefined();
  });
});

describe("composer controller", () => {
  test("restores composer input after failure and clears it after a successful send", async () => {
    const controller = new ComposerController();
    controller.setValue("continue");
    const pending = deferred<boolean>();
    const first = controller.submit(false, async () => pending.promise);

    expect(controller.getSnapshot()).toEqual({ value: "continue", pending: true });
    expect(await controller.submit(false, async () => true)).toBe(false);
    pending.resolve(false);
    expect(await first).toBe(false);
    expect(controller.getSnapshot()).toEqual({ value: "continue", pending: false });

    expect(await controller.submit(false, async () => true)).toBe(true);
    expect(controller.getSnapshot()).toEqual({ value: "", pending: false });
  });
});

describe("Sent controller", () => {
  test("working before RPC completion clears Sent permanently for the next prompt", () => {
    const controller = new SentController();
    let currentStatus: { state: string } = { state: "blocked" };
    const pending = deferred<void>();
    const rpc = pending.promise.then(() => controller.mark(currentStatus, 1_500));

    controller.updateStatus({ state: "working" }, 1_200);
    currentStatus = { state: "working" };
    pending.resolve();

    return rpc.then(() => {
      expect(controller.getSnapshot()).toBeUndefined();
      controller.updateStatus({ state: "blocked" }, 1_800);
      expect(controller.getSnapshot()).toBeUndefined();
    });
  });

  test("expires stored Sent and stops its active timer state", () => {
    const controller = new SentController();
    controller.mark({ state: "blocked" }, 10_000);
    expect(controller.getSnapshot()).toEqual({ sentAt: 10_000 });

    controller.expire(30_000);
    expect(controller.getSnapshot()).toBeUndefined();
  });
});
