/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { agentRoute, agentRowActions, dispatchAgentRowAction, retryConnection } from "./rowMenu.ts";

describe("agent row menu", () => {
  test("offers copy and take over to a control device", () => {
    expect(agentRowActions("control").map(({ label }) => label)).toEqual([
      "Copy address",
      "Take over",
    ]);
  });

  test("does not offer take over to a watch device", () => {
    expect(agentRowActions("watch").map(({ label }) => label)).toEqual(["Copy address"]);
  });

  test("encodes remote addresses as a single agent route segment", () => {
    expect(agentRoute("box/t7")).toBe("/agent/box%2Ft7");
    expect(agentRoute("box/t7", true)).toBe("/agent/box%2Ft7?takeover=1");
  });

  test("dispatches copy and take-over effects for the selected address", async () => {
    const effects: string[] = [];
    const handlers = {
      copyAddress: async (address: string) => {
        effects.push(`copy:${address}`);
      },
      takeOver: (address: string) => effects.push(`take-over:${address}`),
    };

    await dispatchAgentRowAction("copy-address", "box/t7", handlers);
    await dispatchAgentRowAction("take-over", "box/t7", handlers);

    expect(effects).toEqual(["copy:box/t7", "take-over:box/t7"]);
  });

  test("retries by stopping before starting the active manager", () => {
    const calls: string[] = [];
    retryConnection({
      stop: () => calls.push("stop"),
      start: () => calls.push("start"),
    });
    retryConnection(undefined);

    expect(calls).toEqual(["stop", "start"]);
  });
});
