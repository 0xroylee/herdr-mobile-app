/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createBridgeApi } from "../../net/bridge-api.ts";
import type { RouteOpener } from "../../net/route-opener.ts";
import { createMachinesStore } from "../../store/machines.ts";
import { createMemorySecrets, createMemoryStorage } from "../../store/memory.ts";
import { PairingController } from "./pair-controller.ts";

describe("PairingController", () => {
  test("shows refreshed state for a known key without pairing again", async () => {
    const bridgeKey = base64Url("x".repeat(32));
    const secrets = createMemorySecrets([["mac-1", "kept-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine({
      id: "mac-1",
      name: "MacBook",
      routes: {
        direct: "https://mac.tailnet.ts.net",
        secure: { url: "https://old-edge.example.test", key: bridgeKey },
      },
      role: "control",
      deviceId: "device-1",
    });
    const controller = new PairingController(
      createBridgeApi(async () => {
        throw new Error("a fresh link must not redeem its code");
      }),
      secrets,
      machines,
      "my-iphone",
      noRoute,
    );

    controller.acceptScan({
      direct: "https://untrusted.example.test",
      secure: "https://new-edge.example.test",
      bridgeKey,
      code: "ABCD2345",
    });
    await waitForPairing(controller);

    expect(controller.getSnapshot().paired).toEqual({ kind: "refreshed", machineName: "MacBook" });
    expect(controller.getSnapshot().manual).toBe(false);
    expect(machines.getState().machines["mac-1"]?.routes).toEqual({
      direct: "https://mac.tailnet.ts.net",
      secure: { url: "https://new-edge.example.test", key: bridgeKey },
    });
    expect(machines.getState().activeId).toBe("mac-1");
    expect(await secrets.get("mac-1")).toBe("kept-token");
  });
});

const noRoute: RouteOpener = () => {
  throw new Error("refreshing a link must not open a route");
};

async function waitForPairing(controller: PairingController): Promise<void> {
  if (!controller.getSnapshot().busy) return;
  await new Promise<void>((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = controller.subscribe(() => {
      if (!controller.getSnapshot().busy) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
