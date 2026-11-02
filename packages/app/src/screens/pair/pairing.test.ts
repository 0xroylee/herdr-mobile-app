/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { BridgeApiError, type BridgeFetch, createBridgeApi } from "../../net/bridge-api.ts";
import type { ConnectionManager } from "../../net/connection.ts";
import type { ConnectionState } from "../../store/core.ts";
import { createMachinesStore } from "../../store/machines.ts";
import { createMemorySecrets, createMemoryStorage } from "../../store/memory.ts";
import type { Secrets } from "../../store/secrets.ts";
import { connectionLineState } from "./connection-line-state.ts";
import { PairingController } from "./pair-controller.ts";
import { createPairFragmentHandoff } from "./pair-fragment.ts";
import {
  pairAndStore,
  pairingCanRetry,
  pairingDeviceName,
  pairingErrorMessage,
  parsePairingInput,
} from "./pairing.ts";
import { createScannerController } from "./scanner-controller.ts";
import { createSnippetController } from "./snippet-controller.ts";

describe("pairing flow", () => {
  test("parses pasted pair links and typed bridge details", () => {
    const link = makePairLink("https://mac.tailnet.ts.net", "ABCD2345");

    expect(parsePairingInput(link, "")).toEqual({
      url: "https://mac.tailnet.ts.net",
      code: "ABCD2345",
    });
    expect(parsePairingInput("https://mac.tailnet.ts.net/", "ABCD2345")).toEqual({
      url: "https://mac.tailnet.ts.net",
      code: "ABCD2345",
    });
    expect(parsePairingInput("https://mac.tailnet.ts.net/path", "ABCD2345")).toBeUndefined();
  });

  test("captures, clears, and consumes a pair fragment once with no machine paired", () => {
    const { handoff, clearedTo } = makeHandoff();

    expect(clearedTo()).toBe("/app?keep=1");
    expect(handoff.hasPending()).toBe(true);
    expect(handoff.shouldRedirectToPair(false)).toBe(true);
    expect(handoff.consume()).toEqual({ url: "https://mac.tailnet.ts.net", code: "ABCD2345" });
    expect(handoff.consume()).toBeUndefined();
    expect(handoff.hasPending()).toBe(false);
    expect(handoff.shouldRedirectToPair(false)).toBe(true);
  });

  test("opens the pairing route for a captured fragment even when a machine is paired", () => {
    const { handoff } = makeHandoff();

    expect(handoff.shouldRedirectToPair(true)).toBe(true);
    expect(handoff.consume()).toEqual({ url: "https://mac.tailnet.ts.net", code: "ABCD2345" });
    expect(handoff.shouldRedirectToPair(true)).toBe(false);
  });

  test("stores the token separately and activates the paired machine", async () => {
    const secrets = createMemorySecrets();
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    let requestName: string | undefined;
    const api = createBridgeApi(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { code: string; name?: string };
      expect(request.code).toBe("ABCD2345");
      requestName = request.name;
      return jsonResponse({
        deviceId: "device-1",
        token: "secret-token",
        role: "control",
        machine: { id: "mac-1", name: "MacBook" },
      });
    });

    const result = await pairAndStore(
      { url: "https://mac.tailnet.ts.net", code: "ABCD2345" },
      api,
      secrets,
      machines,
      "my-iphone",
    );

    expect(requestName).toBe("my-iphone");
    expect(await secrets.get("mac-1")).toBe("secret-token");
    expect(machines.getState().activeId).toBe("mac-1");
    expect(machines.getState().machines["mac-1"]).toEqual({
      id: "mac-1",
      name: "MacBook",
      url: "https://mac.tailnet.ts.net",
      role: "control",
      deviceId: "device-1",
    });
    expect(result).toEqual({
      machineName: "MacBook",
      deviceName: "my-iphone",
    });
  });

  test("does not add a machine if saving its token fails", async () => {
    const baseSecrets = createMemorySecrets();
    const secrets: Secrets = {
      ...baseSecrets,
      set: async () => Promise.reject(new Error("secure storage unavailable")),
    };
    const machines = createMachinesStore(createMemoryStorage(), baseSecrets);
    const api = createBridgeApi(async () =>
      jsonResponse({
        deviceId: "device-1",
        token: "secret-token",
        role: "watch",
        machine: { id: "mac-1", name: "MacBook" },
      }),
    );

    await expect(
      pairAndStore({ url: "https://mac.tailnet.ts.net", code: "ABCD2345" }, api, secrets, machines),
    ).rejects.toThrow("secure storage unavailable");
    expect(machines.getState().machines).toEqual({});
  });

  test("maps pairing errors and picks a readable device name", () => {
    const forbidden = new BridgeApiError(403, "forbidden", "denied");
    const badCode = new BridgeApiError(400, "bad_code", "invalid");
    const networkError = new TypeError("fetch failed");

    expect(pairingErrorMessage(forbidden)).toContain("Tailscale");
    expect(pairingErrorMessage(badCode)).toContain("expired");
    expect(pairingErrorMessage(networkError)).toContain("Can't reach");
    expect(pairingCanRetry(forbidden)).toBe(true);
    expect(pairingCanRetry(badCode)).toBe(false);
    expect(pairingCanRetry(networkError)).toBe(true);
    expect(pairingDeviceName("  my-iphone  ", false)).toBe("my-iphone");
    expect(pairingDeviceName(undefined, true)).toBe("Browser");
  });

  test("accepts one valid scanner code and de-duplicates later scans", () => {
    const scanner = createScannerController();
    const link = makePairLink("https://mac.tailnet.ts.net", "ABCD2345");

    expect(scanner.scan("not a pairing code")).toBeUndefined();
    expect(scanner.getSnapshot().message).toBe("This QR code isn't a Herdr pairing code.");
    expect(scanner.scan(link)).toEqual({ url: "https://mac.tailnet.ts.net", code: "ABCD2345" });
    expect(scanner.getSnapshot()).toEqual({ accepted: true });
    expect(scanner.scan(link)).toBeUndefined();
  });

  test("copies exactly herdr-bridge pair", async () => {
    let copied: string | undefined;
    const clipboard = {
      setStringAsync: async (value: string) => {
        copied = value;
        return true;
      },
    };
    const snippet = createSnippetController(clipboard);

    await snippet.copy();

    expect(copied).toBe("herdr-bridge pair");
    expect(snippet.getSnapshot()).toEqual({ copied: true, failed: false });
  });

  test("reports a failed copy when the clipboard returns false", async () => {
    const snippet = createSnippetController({ setStringAsync: async () => false });

    await snippet.copy();

    expect(snippet.getSnapshot()).toEqual({ copied: false, failed: true });
  });

  test("reports a failed copy when the clipboard rejects", async () => {
    const snippet = createSnippetController({
      setStringAsync: async () => Promise.reject(new Error("clipboard failed")),
    });

    await snippet.copy();

    expect(snippet.getSnapshot()).toEqual({ copied: false, failed: true });
  });

  test("shows connection state truthfully through connect, failure, and disconnect", () => {
    expect(connectionLineState("connecting", "MacBook Pro", "my-iphone")).toEqual({
      message: "Connecting to MacBook Pro…",
      tone: "muted",
      indicator: "working",
    });
    expect(connectionLineState("connected", "MacBook Pro", "my-iphone").message).toBe(
      "Connected as my-iphone",
    );
    expect(connectionLineState("unauthorized", "MacBook Pro", "my-iphone").message).toContain(
      "Pairing must be repeated",
    );
    expect(connectionLineState("offline", "MacBook Pro", "my-iphone").message).toBe(
      "Disconnected from MacBook Pro.",
    );
  });

  test("propagates state updates from the active connection manager", () => {
    const { controller } = createPairingHarness(async () => jsonResponse(makePairReply()));
    const manager = makeConnectionManager("connecting");

    controller.setConnectionManager(manager.manager);
    expect(controller.getSnapshot().connectionState).toBe("connecting");

    manager.emit("connected");

    expect(controller.getSnapshot().connectionState).toBe("connected");
  });

  test("unsubscribes the replaced manager and ignores its late updates", () => {
    const { controller } = createPairingHarness(async () => jsonResponse(makePairReply()));
    const previous = makeConnectionManager("connected");
    const replacement = makeConnectionManager("reconnecting");
    controller.setConnectionManager(previous.manager);

    controller.setConnectionManager(replacement.manager);
    expect(previous.isUnsubscribed()).toBe(true);
    expect(controller.getSnapshot().connectionState).toBe("reconnecting");

    previous.deliverLate("unauthorized");
    expect(controller.getSnapshot().connectionState).toBe("reconnecting");
    replacement.emit("connected");
    expect(controller.getSnapshot().connectionState).toBe("connected");
  });

  test("pairs successfully and follows the replacement manager state", async () => {
    let pairCalls = 0;
    const { controller, machines, secrets } = createPairingHarness(async (input, init) => {
      pairCalls += 1;
      expect(input).toBe("https://mac.tailnet.ts.net/api/pair");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "ABCD2345", name: "my-iphone" });
      return jsonResponse(makePairReply());
    });
    const previousManager = makeConnectionManager("connected");
    controller.setConnectionManager(previousManager.manager);

    submitManualPair(controller);
    await waitForPairing(controller);

    expect(pairCalls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      code: "",
      paired: { machineName: "MacBook", deviceName: "my-iphone" },
    });
    expect(await secrets.get("mac-1")).toBe("secret-token");
    expect(machines.getState().activeId).toBe("mac-1");

    const nextManager = makeConnectionManager("connecting");
    controller.setConnectionManager(nextManager.manager);
    expect(previousManager.isUnsubscribed()).toBe(true);
    expect(controller.getSnapshot().connectionState).toBe("connecting");
    nextManager.emit("connected");
    expect(controller.getSnapshot().connectionState).toBe("connected");
  });

  test("shows a retryable pairing failure and retries the same pairing", async () => {
    let pairCalls = 0;
    const { controller, machines } = createPairingHarness(async () => {
      pairCalls += 1;
      return pairCalls === 1
        ? jsonResponse({ error: "unavailable", message: "temporarily unavailable" }, 503)
        : jsonResponse(makePairReply());
    });

    submitManualPair(controller);
    await waitForPairing(controller);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      retryable: true,
      banner: "The bridge couldn't complete pairing. Try again.",
    });

    controller.retry();
    await waitForPairing(controller);

    expect(pairCalls).toBe(2);
    expect(controller.getSnapshot().paired).toEqual({
      machineName: "MacBook",
      deviceName: "my-iphone",
    });
    expect(machines.getState().activeId).toBe("mac-1");
  });

  test("ignores a second pairing submission while the first is busy", async () => {
    let pairCalls = 0;
    let resolveFetch!: (response: Response) => void;
    const { controller } = createPairingHarness(() => {
      pairCalls += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });

    submitManualPair(controller);
    expect(controller.getSnapshot().busy).toBe(true);
    controller.submitManual();
    expect(pairCalls).toBe(1);

    resolveFetch(jsonResponse(makePairReply()));
    await waitForPairing(controller);

    expect(pairCalls).toBe(1);
    expect(controller.getSnapshot().paired?.machineName).toBe("MacBook");
  });
});

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

function makeConnectionManager(initialState: ConnectionState) {
  let state = initialState;
  let listener: ((next: ConnectionState) => void) | undefined;
  let unsubscribed = false;
  const manager: ConnectionManager = {
    start() {},
    stop() {},
    attach: async () => {
      throw new Error("not used by pairing tests");
    },
    call: async () => {
      throw new Error("not used by pairing tests");
    },
    state: () => state,
    subscribe(nextListener) {
      listener = nextListener;
      nextListener(state);
      return () => {
        unsubscribed = true;
      };
    },
  };
  return {
    manager,
    emit(next: ConnectionState) {
      state = next;
      listener?.(next);
    },
    deliverLate(next: ConnectionState) {
      listener?.(next);
    },
    isUnsubscribed: () => unsubscribed,
  };
}

function makeHandoff() {
  const location = new URL(
    `https://app.example/app?keep=1${makePairLink("https://mac.tailnet.ts.net", "ABCD2345").slice("https://mac.tailnet.ts.net/".length)}`,
  );
  let cleared: string | undefined;
  const history = {
    state: null,
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      cleared = url === undefined || url === null ? undefined : String(url);
    },
  };
  return {
    handoff: createPairFragmentHandoff(location, history),
    clearedTo: () => cleared,
  };
}

function makePairLink(url: string, code: string): string {
  const payload = base64Url(JSON.stringify({ u: url, c: code }));
  return `https://mac.tailnet.ts.net/#pair=${payload}`;
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makePairReply() {
  return {
    deviceId: "device-1",
    token: "secret-token",
    role: "control",
    machine: { id: "mac-1", name: "MacBook" },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
