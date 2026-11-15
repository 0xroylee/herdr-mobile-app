/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { type BridgeFetch, createBridgeApi } from "../../net/bridge-api.ts";
import type { RouteOpener } from "../../net/route-opener.ts";
import type { Socket } from "../../net/socket.ts";
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

  test("does not offer Retry for a channel bad-pair-code close", async () => {
    let openCalls = 0;
    let httpCalls = 0;
    const secrets = createMemorySecrets();
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    const controller = new PairingController(
      createBridgeApi(async () => {
        httpCalls += 1;
        throw new Error("secure-only pairing must not call HTTP");
      }),
      secrets,
      machines,
      "my-iphone",
      () => {
        openCalls += 1;
        return createPairingConnection((_data, socket) => {
          queueMicrotask(() => socket.onclose?.({ code: 4402 }));
        });
      },
    );

    controller.acceptScan(secureOnlyOffer());
    await waitForPairing(controller);

    expect(controller.getSnapshot()).toMatchObject({
      retryable: false,
      banner: "That pairing code is invalid or has expired. Generate a new code on your Mac.",
    });
    controller.retry();
    expect(openCalls).toBe(1);
    expect(httpCalls).toBe(0);
  });

  test("does not offer Retry for a channel key-mismatch close before PairMessage", async () => {
    let openCalls = 0;
    let sendCalls = 0;
    let httpCalls = 0;
    const secrets = createMemorySecrets();
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    const controller = new PairingController(
      createBridgeApi(async () => {
        httpCalls += 1;
        throw new Error("secure-only pairing must not call HTTP");
      }),
      secrets,
      machines,
      "my-iphone",
      () => {
        openCalls += 1;
        return createPairingConnection(() => {
          sendCalls += 1;
        }, 4003);
      },
    );

    controller.acceptScan(secureOnlyOffer());
    await waitForPairing(controller);

    expect(controller.getSnapshot()).toMatchObject({
      retryable: false,
      banner: "This Mac's bridge identity changed. Pair again.",
    });
    controller.retry();
    expect(openCalls).toBe(1);
    expect(sendCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });

  test("shows Tailscale guidance for typed 403 pairing access failures", async () => {
    const { controller } = createPairingHarness(async () =>
      jsonResponse({ error: "forbidden", message: "denied" }, 403),
    );

    submitManualPair(controller);
    await waitForPairing(controller);

    expect(controller.getSnapshot().banner).toBe(
      "Typing works over Tailscale. Without it, scan the code or paste the full link.",
    );
  });

  test("shows Tailscale guidance for typed 404 pairing route failures", async () => {
    const { controller } = createPairingHarness(async () =>
      jsonResponse({ error: "not_found", message: "route not found" }, 404),
    );

    submitManualPair(controller);
    await waitForPairing(controller);

    expect(controller.getSnapshot().banner).toBe(
      "Typing works over Tailscale. Without it, scan the code or paste the full link.",
    );
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

function createPairingHarness(fetcher: BridgeFetch) {
  const secrets = createMemorySecrets();
  const machines = createMachinesStore(createMemoryStorage(), secrets);
  const controller = new PairingController(
    createBridgeApi(fetcher),
    secrets,
    machines,
    "my-iphone",
  );
  return { controller, machines, secrets };
}

function submitManualPair(controller: PairingController): void {
  controller.showManualEntry();
  controller.setAddress("https://mac.tailnet.ts.net");
  controller.setCode("ABCD2345");
  controller.submitManual();
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function secureOnlyOffer() {
  return {
    secure: "https://edge.example.test",
    bridgeKey: base64Url("x".repeat(32)),
    code: "ABCD2345",
  };
}

function createPairingConnection(
  onSend: (data: string, socket: Socket) => void,
  closeBeforeOpen?: number,
): ReturnType<RouteOpener> {
  let socket: Socket;
  socket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (typeof data !== "string") throw new Error("pair message must be text");
      onSend(data, socket);
    },
    close() {},
  };
  queueMicrotask(() => {
    if (closeBeforeOpen === undefined) socket.onopen?.();
    else socket.onclose?.({ code: closeBeforeOpen });
  });
  return { socket, fetch: async () => new Response(null) };
}
