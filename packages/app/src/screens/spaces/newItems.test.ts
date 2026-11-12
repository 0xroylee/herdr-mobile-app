/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces } from "@/model/spaces.ts";
import { newTabTarget } from "@/model/spaceTarget.ts";
import { BridgeApiError } from "@/net/bridge-api.ts";
import type { BridgeCalls } from "@/net/bridge-calls.ts";
import { createNewSpace, createNewTab, herdrNotRunningMessage } from "./newItems.ts";

const machine = { id: "machine-1", role: "control" } as const;

const targetTerminal: Terminal = {
  address: "t1",
  argv: ["codex"],
  cols: 80,
  created_ms: 1,
  cwd: "/repo",
  labels: { "herdr.space": "sp1" },
  rows: 24,
  screen: "exact",
  state: "live",
  status: { state: "idle" },
};
const targetSpace = deriveSpaces([targetTerminal], undefined)[0]?.spaces[0];
if (targetSpace === undefined) throw new Error("Expected a label-backed space fixture");
const target = newTabTarget(targetSpace, undefined);
if (target === undefined) throw new Error("Expected a new-tab target from the label fixture");

function dependencies(appDo: BridgeCalls["appDo"] = async () => ({ ok: true })) {
  const calls: unknown[][] = [];
  const api = {
    appDo: async (...args: Parameters<BridgeCalls["appDo"]>) => {
      calls.push(args);
      return appDo(...args);
    },
  };
  return { dependencies: { calls: api }, calls };
}

describe("space creation actions", () => {
  test("creates a space through the active machine's BridgeCalls", async () => {
    const { dependencies: deps, calls } = dependencies();

    await expect(createNewSpace(deps, machine)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([["space.new"]]);
  });

  test("creates a tab with the label target minted from a row", async () => {
    const { dependencies: deps, calls } = dependencies();

    await expect(createNewTab(deps, machine, target)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([["tab.new", { space: "sp1" }]]);
  });

  test("shows the kit message when the bridge reports Herdr is not running", async () => {
    const { dependencies: deps } = dependencies(async () => {
      throw new BridgeApiError(409, "herdr_not_running", "Conflict");
    });

    await expect(createNewSpace(deps, machine)).resolves.toEqual({
      ok: false,
      message: herdrNotRunningMessage,
    });
  });

  test("does not call the bridge for watch-only devices", async () => {
    const { dependencies: deps, calls } = dependencies();

    await expect(createNewTab(deps, { ...machine, role: "watch" }, target)).resolves.toEqual({
      ok: false,
      message: "This device is read-only.",
    });
    expect(calls).toEqual([]);
  });

  test("reports a disconnected BridgeCalls failure", async () => {
    const { dependencies: deps } = dependencies(async () => {
      throw new BridgeApiError(503, "not_connected", "Not connected to Mac.");
    });

    await expect(createNewSpace(deps, machine)).resolves.toEqual({
      ok: false,
      message: "Not connected to Mac.",
    });
  });
});
