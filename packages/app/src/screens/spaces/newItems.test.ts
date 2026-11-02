/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces } from "@/model/spaces.ts";
import { type BridgeApi, BridgeApiError } from "@/net/bridge-api.ts";
import type { Secrets } from "@/store/secrets.ts";
import { createNewSpace, createNewTab, herdrNotRunningMessage } from "./newItems.ts";
import { newTabTarget } from "./spaceTarget.ts";

const machine = { id: "machine-1", url: "https://mac.tailnet.ts.net", role: "control" } as const;

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

function dependencies(
  appDo: BridgeApi["appDo"] = async () => ({ ok: true }),
  token: string | null = "device-token",
) {
  const calls: unknown[][] = [];
  const api = {
    appDo: async (...args: Parameters<BridgeApi["appDo"]>) => {
      calls.push(args);
      return appDo(...args);
    },
  };
  const secrets: Pick<Secrets, "get"> = {
    get: async (key) => (key === machine.id ? token : null),
  };
  return { dependencies: { api, secrets }, calls };
}

describe("space creation actions", () => {
  test("creates a space on the active machine with its secret token", async () => {
    const { dependencies: deps, calls } = dependencies();

    await expect(createNewSpace(deps, machine)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([[machine.url, "device-token", "space.new"]]);
  });

  test("creates a tab with the label target minted from a row", async () => {
    const { dependencies: deps, calls } = dependencies();

    await expect(createNewTab(deps, machine, target)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([[machine.url, "device-token", "tab.new", { space: "sp1" }]]);
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

  test("reports a missing token without calling the bridge", async () => {
    const { dependencies: deps, calls } = dependencies(undefined, null);

    await expect(createNewSpace(deps, machine)).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});
