/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import { FakeCore, line } from "@herdr-mobile/hc-client/testing";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WS_CLOSE_CODES,
  FrameKind,
  type Terminal,
} from "@herdr-mobile/protocol";
import {
  createMemoryDuplexPair,
  type DuplexSocket,
  encodeBase64Url,
  generateStaticKeyPair,
  openInitiator,
  openResponder,
  type SecureSession,
  type StaticKeyPair,
} from "@herdr-mobile/secure-channel";
import { createCoreStore } from "../store/core.ts";
import {
  type LifecycleAppStateSource,
  type LifecycleStores,
  startLifecycle,
} from "../store/lifecycle.ts";
import type { Machine } from "../store/machines.ts";
import { createMemorySecrets } from "../store/memory.ts";
import type { BridgeFetch } from "./bridge-api.ts";
import { createChannelFetch } from "./channel-fetch.ts";
import { type Clock, createConnectionManager } from "./connection.ts";
import type { MachineRoute, RouteConnection } from "./route-opener.ts";
import type { Socket } from "./socket.ts";

const directUrl = "https://mac.tailnet.ts.net";
const secureUrl = "https://bridge.example.test";
const pinnedKey = "pinned-bridge-key";
const machine: Machine = {
  id: "machine-1",
  name: "Mac",
  routes: { direct: directUrl },
  role: "control",
  deviceId: "device-1",
};

describe("connection manager", () => {
  test("authenticates, negotiates hello, subscribes unfiltered and fetches the layout", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const socket = new FakeSocket();
    socket.core.snapshot = { seq: 10, terminals: [terminal("t1")] };
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      openRoute: (route) => {
        expect(route).toEqual({ kind: "direct", url: directUrl });
        return routeConnection(socket);
      },
      clock,
    });
    const states: string[] = [];
    manager.subscribe((state) => states.push(state));

    manager.start();
    await flush();
    socket.open();
    await waitFor(() => manager.state() === "connected");

    expect(socket.authMessage).toEqual({ v: BRIDGE_PROTOCOL_VERSION, token: "secret-token" });
    expect(socket.core.calls.slice(0, 3)).toEqual(["hello", "events.subscribe", "doc.get"]);
    expect(socket.core.subscribed).toEqual([{}]);
    expect(coreStore.getState().machines[machine.id]?.connection).toBe("connected");
    expect(coreStore.getState().machines[machine.id]?.route).toBe("direct");
    expect(coreStore.getState().machines[machine.id]?.terminals.t1?.address).toBe("t1");
    expect(coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name).toBe("space-1");
    expect(states).toContain("connected");

    socket.sendSubscriptionNotification(11, "event", {
      type: "turn",
      terminal: "t1",
      data: { turn: 2 },
    });
    await waitFor(() => coreStore.getState().machines[machine.id]?.terminals.t1?.turn === 2);
    manager.stop();
  });

  test("refetches the layout after a doc event and a missed snapshot", async () => {
    const { manager, socket, coreStore } = setupConnected();
    manager.start();
    await connect(manager, socket);
    expect(socket.core.calls.filter((method) => method === "doc.get")).toHaveLength(1);

    socket.sendSubscriptionNotification(11, "event", {
      type: "doc",
      data: { name: "herdr-app", version: 2 },
    });
    await waitFor(
      () => coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name === "space-2",
    );

    socket.sendSubscriptionNotification(12, "missed", { terminals: [terminal("t2")] });
    await waitFor(
      () => coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name === "space-3",
    );
    expect(Object.keys(coreStore.getState().machines[machine.id]?.terminals ?? {})).toEqual(["t2"]);
    manager.stop();
  });

  test("the first authenticated route wins and closes its loser before it authenticates", async () => {
    const secureMachine = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const coreStore = createCoreStore();
    const manager = createManager(secureMachine, coreStore, opened);

    manager.start();
    await waitFor(() => opened.length === 2);
    const direct = socketFor(opened, "direct");
    const secure = socketFor(opened, "secure");
    secure.open();
    await waitFor(() => manager.state() === "connected");

    expect(coreStore.getState().machines[machine.id]?.route).toBe("secure");
    expect(secure.authMessage).toEqual({ v: BRIDGE_PROTOCOL_VERSION, token: "secret-token" });
    expect(direct.authMessage).toBeUndefined();
    expect(direct.closeRequests).toEqual([
      { code: 1000, reason: "another route authenticated first" },
    ]);
    manager.stop();
  });

  test("a failed candidate cannot authenticate late or update the other route", async () => {
    const input = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const updates: unknown[] = [];
    const manager = createConnectionManager({
      machine: input,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      updateRoutes: (_id, routes) => updates.push(routes),
      openRoute: (route) => {
        const socket = new FakeSocket();
        opened.push({ route, socket });
        return routeConnection(socket);
      },
    });

    manager.start();
    await waitFor(() => opened.length === 2);
    const direct = socketFor(opened, "direct");
    const secure = socketFor(opened, "secure");
    const lateAuthentication = direct.onmessage;
    direct.serverClose(1006);
    secure.open();
    await waitFor(() => manager.state() === "connected");
    lateAuthentication?.(
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        ok: true,
        role: "control",
        machine: { id: machine.id, name: machine.name },
        routes: { direct: "https://late.tailnet.ts.net" },
        bridgeKey: "late-key",
      }),
    );
    await flush();

    expect(manager.state()).toBe("connected");
    expect(updates).toEqual([]);
    expect(direct.closeRequests).toEqual([{ code: 1000, reason: "route failed" }]);
    expect(secure.closeRequests).toEqual([]);
    manager.stop();
  });

  test("direct route wins when it authenticates first", async () => {
    const secureMachine = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const coreStore = createCoreStore();
    const manager = createManager(secureMachine, coreStore, opened);

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "direct").open();
    await waitFor(() => manager.state() === "connected");

    expect(coreStore.getState().machines[machine.id]?.route).toBe("direct");
    expect(socketFor(opened, "secure").closeRequests).toHaveLength(1);
    manager.stop();
  });

  test("calls over a secure winner use the authenticated channel fetch", async () => {
    const opened: OpenedSocket[] = [];
    const requests: string[] = [];
    const manager = createConnectionManager({
      machine: withSecureRoute(),
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      openRoute: (route) => {
        const socket = new FakeSocket();
        opened.push({ route, socket });
        return routeConnection(socket, async (input) => {
          requests.push(String(input));
          return Response.json({ secure: true });
        });
      },
    });

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "secure").open();
    await waitFor(() => manager.state() === "connected");

    await expect(manager.calls().health()).resolves.toEqual({ secure: true });
    expect(requests).toEqual([`${secureUrl}/api/health`]);
    manager.stop();
  });

  test("a pending secure call through the manager rejects with connection_lost", async () => {
    const [clientSocket, serverSocket] = createMemoryDuplexPair();
    const identity = generateStaticKeyPair();
    const serverOpening = openResponder(serverSocket, { localStatic: identity });
    const clientOpening = openInitiator(clientSocket, { remoteStaticKey: identity.publicKey });
    const [clientSession, serverSession] = await Promise.all([clientOpening, serverOpening]);
    let requestReceived = false;
    let clientSessionClosed = false;
    let pendingResult: { error?: unknown } | undefined;
    serverSession.onRecord((kind) => {
      if (kind === "text") requestReceived = true;
    });
    void clientSession.closed.then(() => (clientSessionClosed = true));
    const secureOnly: Machine = {
      ...machine,
      routes: { secure: { url: secureUrl, key: pinnedKey } },
    };
    const socket = new FakeSocket();
    const manager = createConnectionManager({
      machine: secureOnly,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      openRoute: () =>
        routeConnection(socket, createChannelFetch(clientSession, "Mac", new FakeClock())),
      clock: new FakeClock(),
    });

    manager.start();
    await flush();
    socket.open();
    await waitFor(() => manager.state() === "connected");
    const pending = manager.calls().health();
    void pending.then(
      () => (pendingResult = {}),
      (error: unknown) => (pendingResult = { error }),
    );
    await waitFor(() => requestReceived);
    socket.serverClose(1006);
    serverSession.close(1000, "channel ended");
    await waitFor(() => clientSessionClosed);
    await waitFor(() => pendingResult !== undefined);

    expect(pendingResult?.error).toMatchObject({
      name: "BridgeApiError",
      status: 503,
      code: "connection_lost",
      message: "Lost the connection to Mac. Try again.",
    });
    manager.stop();
  });

  test("the authenticated direct reply updates routes and learns the bridge key", async () => {
    const input = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const updates: unknown[] = [];
    const coreStore = createCoreStore();
    const manager = createConnectionManager({
      machine: input,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      updateRoutes: (_id, routes) => updates.push(routes),
      openRoute: (route) => {
        const socket = new FakeSocket({
          authReply: {
            routes: { direct: "https://new.tailnet.ts.net", secure: "https://new-edge.test" },
            bridgeKey: "new-bridge-key",
          },
        });
        opened.push({ route, socket });
        return routeConnection(socket);
      },
    });

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "direct").open();
    await waitFor(() => manager.state() === "connected");

    expect(updates).toEqual([
      {
        direct: "https://new.tailnet.ts.net",
        secure: { url: "https://new-edge.test", key: "new-bridge-key" },
      },
    ]);
    manager.stop();
  });

  test("an AuthReply route update keeps the lifecycle manager through hello", async () => {
    const machineState = createLifecycleMachineState(machine);
    const secrets = createMemorySecrets([[machine.id, "secret-token"]]);
    const coreStore = createCoreStore();
    const opened: OpenedSocket[] = [];
    const managers: ReturnType<typeof createConnectionManager>[] = [];
    const persist = { rehydrate: async () => {}, hasHydrated: () => true };
    const stores: LifecycleStores = {
      settings: { persist, getState: () => ({ ui: { theme: "system" } }) },
      machines: machineState.store,
      seen: { persist },
    };
    const appState: LifecycleAppStateSource = {
      currentState: () => "active",
      subscribe: () => () => {},
    };
    const dispose = startLifecycle({
      stores,
      appState,
      applyTheme: () => {},
      createManager: (selectedMachine, restartConnection) => {
        const manager = createConnectionManager({
          machine: selectedMachine,
          secrets,
          core: coreStore.getState(),
          getMachine: (id) => machineState.getMachine(id),
          updateRoutes: (id, routes) => machineState.updateRoutes(id, routes),
          restartConnection,
          openRoute: (route) => {
            const socket = new FakeSocket({
              authReply: {
                routes: { direct: "https://updated.tailnet.ts.net", secure: secureUrl },
                bridgeKey: pinnedKey,
              },
            });
            opened.push({ route, socket });
            return routeConnection(socket);
          },
          clock: new FakeClock(),
        });
        managers.push(manager);
        return manager;
      },
      onManager: () => {},
      onReady: () => {},
    });

    await waitFor(() => opened.length === 1);
    const socket = socketFor(opened, "direct");
    socket.open();
    await waitFor(() => managers[0]?.state() === "connected");

    expect(managers).toHaveLength(1);
    expect(socket.core.calls).toContain("hello");
    expect(machineState.getMachine(machine.id)?.routes).toEqual({
      direct: "https://updated.tailnet.ts.net",
      secure: { url: secureUrl, key: pinnedKey },
    });
    expect(socket.closeRequests).toEqual([]);
    dispose();
  });

  test("a transient token read failure during route persistence keeps the manager and retries", async () => {
    const machineState = createLifecycleMachineState(machine);
    const baseSecrets = createMemorySecrets([[machine.id, "secret-token"]]);
    let tokenReads = 0;
    let rejectFirstRead!: (error: Error) => void;
    const firstRead = new Promise<string | null>((_resolve, reject) => {
      rejectFirstRead = reject;
    });
    const secrets = {
      ...baseSecrets,
      get: async (id: string) => {
        tokenReads += 1;
        if (tokenReads === 1) return firstRead;
        return baseSecrets.get(id);
      },
    };
    const coreStore = createCoreStore();
    const opened: OpenedSocket[] = [];
    const managers: ReturnType<typeof createConnectionManager>[] = [];
    const clock = new FakeClock();
    let originalManagerStops = 0;
    const persist = { rehydrate: async () => {}, hasHydrated: () => true };
    const stores: LifecycleStores = {
      settings: { persist, getState: () => ({ ui: { theme: "system" } }) },
      machines: machineState.store,
      seen: { persist },
    };
    const appState: LifecycleAppStateSource = {
      currentState: () => "active",
      subscribe: () => () => {},
    };
    const dispose = startLifecycle({
      stores,
      appState,
      applyTheme: () => {},
      createManager: (selectedMachine, restartConnection) => {
        const manager = createConnectionManager({
          machine: selectedMachine,
          secrets,
          core: coreStore.getState(),
          getMachine: (id) => machineState.getMachine(id),
          openRoute: (route) => {
            const socket = new FakeSocket();
            opened.push({ route, socket });
            return routeConnection(socket);
          },
          clock,
          restartConnection,
        });
        const stop = manager.stop.bind(manager);
        manager.stop = () => {
          originalManagerStops += 1;
          stop();
        };
        managers.push(manager);
        return manager;
      },
      onManager: () => {},
      onReady: () => {},
    });

    await waitFor(() => tokenReads === 1);
    machineState.updateRoutes(machine.id, { direct: "https://updated.tailnet.ts.net" });
    rejectFirstRead(new Error("secure storage temporarily unavailable"));
    await waitFor(() => managers[0]?.state() === "reconnecting");
    expect(tokenReads).toBe(1);
    expect(opened).toHaveLength(0);

    expect(managers).toHaveLength(1);
    expect(originalManagerStops).toBe(0);
    expect(tokenReads).toBe(1);

    clock.advance(1_000);
    await waitFor(() => opened.length === 1);
    expect(tokenReads).toBe(2);
    expect(opened[0]?.route).toEqual({
      kind: "direct",
      url: "https://updated.tailnet.ts.net",
    });
    opened[0]?.socket.open();
    await waitFor(() => managers[0]?.state() === "connected");

    expect(managers).toHaveLength(1);
    expect(originalManagerStops).toBe(0);
    dispose();
  });

  test("unknown secure control records leave core and API calls connected", async () => {
    await withMemoryConnectionWebSocket(async (identity) => {
      MemoryConnectionWebSocket.onServerSession = (session) => {
        const core = new FakeCore((bytes) => session.send("binary", bytes));
        core.answer = (method) => {
          if (method !== "doc.get") return undefined;
          const count = core.calls.filter((call) => call === "doc.get").length;
          return {
            value: { spaces: [{ id: "space", name: `space-${count}`, tabs: [] }] },
            version: count,
          };
        };
        session.onRecord((kind, data) => {
          if (kind === "binary") {
            core.write(data);
            return;
          }
          const record = JSON.parse(utf8Decode(data)) as Record<string, unknown>;
          if (record.t === "req") {
            session.send(
              "text",
              utf8Encode(
                JSON.stringify({ t: "res", id: record.id, status: 200, body: '{"ok":true}' }),
              ),
            );
            return;
          }
          if (record.v === BRIDGE_PROTOCOL_VERSION && typeof record.token === "string") {
            session.send(
              "text",
              utf8Encode(
                JSON.stringify({
                  v: BRIDGE_PROTOCOL_VERSION,
                  ok: true,
                  role: "control",
                  machine: { id: machine.id, name: machine.name },
                }),
              ),
            );
          }
        });
      };

      const secureMachine: Machine = {
        ...machine,
        routes: {
          secure: {
            url: secureUrl,
            key: encodeBase64Url(identity.publicKey),
          },
        },
      };
      const manager = createConnectionManager({
        machine: secureMachine,
        secrets: createMemorySecrets([[machine.id, "secret-token"]]),
        core: createCoreStore().getState(),
      });
      manager.start();
      await waitFor(() => manager.state() === "connected");

      const serverSession = MemoryConnectionWebSocket.instances[0]?.serverSession;
      expect(serverSession).toBeDefined();
      serverSession?.send(
        "text",
        utf8Encode(JSON.stringify({ t: "future_extension", value: "ignored" })),
      );
      await flush();

      expect(manager.state()).toBe("connected");
      await expect(manager.calls().health()).resolves.toEqual({ ok: true });
      await expect(manager.call("doc.get", { name: "herdr-app" })).resolves.toMatchObject({
        value: { spaces: [{ id: "space", name: "space-2" }] },
      });
      expect(manager.state()).toBe("connected");
      manager.stop();
    });
  });

  test("a route persistence callback that stops the manager prevents bootstrap", async () => {
    const socket = new FakeSocket({
      authReply: { routes: { direct: "https://updated.tailnet.ts.net" } },
    });
    const coreStore = createCoreStore();
    let manager: ReturnType<typeof createConnectionManager>;
    manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      updateRoutes: () => manager.stop(),
      openRoute: () => routeConnection(socket),
    });

    manager.start();
    await flush();
    socket.open();
    await waitFor(() => manager.state() === "offline");
    await flush();

    expect(socket.core.calls).not.toContain("hello");
    expect(coreStore.getState().machines[machine.id]?.connection).toBe("offline");
  });

  test("a secure winner keeps the stored pinned key while accepting advertised route changes", async () => {
    const input = withSecureRoute();
    const opened: OpenedSocket[] = [];
    let updated: unknown;
    const manager = createConnectionManager({
      machine: input,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      updateRoutes: (_id, routes) => (updated = routes),
      openRoute: (route) => {
        const socket = new FakeSocket({
          authReply: {
            routes: { direct: "https://updated.tailnet.ts.net", secure: "https://edge-new.test" },
            bridgeKey: "untrusted-replacement-key",
          },
        });
        opened.push({ route, socket });
        return routeConnection(socket);
      },
    });

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "secure").open();
    await waitFor(() => manager.state() === "connected");

    expect(updated).toEqual({
      direct: "https://updated.tailnet.ts.net",
      secure: { url: "https://edge-new.test", key: pinnedKey },
    });
    manager.stop();
  });

  test("4003 on the only secure route becomes identity_changed without retry", async () => {
    const secureOnly: Machine = {
      ...machine,
      routes: { secure: { url: secureUrl, key: pinnedKey } },
    };
    const opened: OpenedSocket[] = [];
    const coreStore = createCoreStore();
    const clock = new FakeClock();
    const manager = createManager(secureOnly, coreStore, opened, clock);

    manager.start();
    await waitFor(() => opened.length === 1);
    socketFor(opened, "secure").serverClose(BRIDGE_WS_CLOSE_CODES.KEY_MISMATCH);
    await waitFor(() => manager.state() === "identity_changed");
    clock.advance(60_000);
    await flush();

    expect(coreStore.getState().machines[machine.id]?.connection).toBe("identity_changed");
    expect(opened).toHaveLength(1);
  });

  test("1012 identity rotation close uses the normal reconnect backoff", async () => {
    const secureOnly: Machine = {
      ...machine,
      routes: { secure: { url: secureUrl, key: pinnedKey } },
    };
    const opened: OpenedSocket[] = [];
    const clock = new FakeClock();
    const manager = createManager(secureOnly, createCoreStore(), opened, clock);

    manager.start();
    await waitFor(() => opened.length === 1);
    socketFor(opened, "secure").serverClose(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED);
    expect(manager.state()).toBe("reconnecting");
    clock.advance(999);
    await flush();
    expect(opened).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => opened.length === 2);
    manager.stop();
  });

  test("a secure 4003 does not block a direct route and the direct reply can rotate the key", async () => {
    const input = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const coreStore = createCoreStore();
    const updates: unknown[] = [];
    const manager = createManager(
      input,
      coreStore,
      opened,
      new FakeClock(),
      (routes) => updates.push(routes),
      { direct: { authReply: { routes: { secure: secureUrl }, bridgeKey: "rotated-key" } } },
    );

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "secure").serverClose(BRIDGE_WS_CLOSE_CODES.KEY_MISMATCH);
    socketFor(opened, "direct").open();
    await waitFor(() => manager.state() === "connected");

    expect(coreStore.getState().machines[machine.id]?.route).toBe("direct");
    expect(updates).toEqual([
      { direct: directUrl, secure: { url: secureUrl, key: "rotated-key" } },
    ]);
    manager.stop();
  });

  test("4401 wins when another failed route reports 4003", async () => {
    const secureMachine = withSecureRoute();
    const opened: OpenedSocket[] = [];
    const coreStore = createCoreStore();
    const manager = createManager(secureMachine, coreStore, opened, new FakeClock(), undefined, {
      direct: { rejectCode: BRIDGE_WS_CLOSE_CODES.BAD_TOKEN },
    });

    manager.start();
    await waitFor(() => opened.length === 2);
    socketFor(opened, "direct").open();
    socketFor(opened, "secure").serverClose(BRIDGE_WS_CLOSE_CODES.KEY_MISMATCH);
    await waitFor(() => manager.state() === "unauthorized");

    expect(coreStore.getState().machines[machine.id]?.connection).toBe("unauthorized");
  });

  test("all ordinary route failures use the reconnect backoff", async () => {
    const opened: OpenedSocket[] = [];
    const clock = new FakeClock();
    const manager = createManager(machine, createCoreStore(), opened, clock);

    manager.start();
    await waitFor(() => opened.length === 1);
    socketFor(opened, "direct").serverClose(1006);
    expect(manager.state()).toBe("reconnecting");
    clock.advance(999);
    await flush();
    expect(opened).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => opened.length === 2);
    manager.stop();
  });

  test("an empty token read uses the normal reconnect backoff", async () => {
    const storedSecrets = createMemorySecrets([[machine.id, "secret-token"]]);
    let tokenReads = 0;
    const secrets = {
      ...storedSecrets,
      get: async (id: string) => {
        tokenReads += 1;
        if (tokenReads === 1) return null;
        return storedSecrets.get(id);
      },
    };
    const opened: OpenedSocket[] = [];
    const clock = new FakeClock();
    const manager = createConnectionManager({
      machine,
      secrets,
      core: createCoreStore().getState(),
      openRoute: (route) => {
        const socket = new FakeSocket();
        opened.push({ route, socket });
        return routeConnection(socket);
      },
      clock,
    });

    manager.start();
    await waitFor(() => manager.state() === "reconnecting");
    expect(tokenReads).toBe(1);
    expect(opened).toHaveLength(0);
    clock.advance(999);
    await flush();
    expect(opened).toHaveLength(0);
    clock.advance(1);
    await waitFor(() => opened.length === 1);
    expect(tokenReads).toBe(2);
    opened[0]?.socket.open();
    await waitFor(() => manager.state() === "connected");
    manager.stop();
  });

  test("caps reconnect backoff at fifteen seconds", async () => {
    const opened: OpenedSocket[] = [];
    const clock = new FakeClock();
    const manager = createManager(machine, createCoreStore(), opened, clock);
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];

    manager.start();
    for (let index = 0; index < delays.length; index += 1) {
      await waitFor(() => opened.length === index + 1);
      opened[opened.length - 1]?.socket.serverClose(1006);
      expect(manager.state()).toBe("reconnecting");
      clock.advance((delays[index] ?? 0) - 1);
      await flush();
      expect(opened).toHaveLength(index + 1);
      clock.advance(1);
    }
    await waitFor(() => opened.length === delays.length + 1);
    manager.stop();
  });

  test("reads the stored routes at the start of each retry", async () => {
    const opened: OpenedSocket[] = [];
    const clock = new FakeClock();
    let storedMachine = machine;
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      getMachine: (id) => (id === storedMachine.id ? storedMachine : undefined),
      openRoute: (route) => {
        const socket = new FakeSocket();
        opened.push({ route, socket });
        return routeConnection(socket);
      },
      clock,
    });

    manager.start();
    await waitFor(() => opened.length === 1);
    socketFor(opened, "direct").serverClose(1006);
    storedMachine = withSecureRoute();
    clock.advance(1_000);
    await waitFor(() => opened.length === 3);

    expect(opened.slice(1).map(({ route }) => route.kind)).toEqual(["direct", "secure"]);
    manager.stop();
  });

  test("stop and restart ignores the previous run's queued open callback", async () => {
    const opened: OpenedSocket[] = [];
    const manager = createManager(machine, createCoreStore(), opened);

    manager.start();
    await waitFor(() => opened.length === 1);
    const oldSocket = socketFor(opened, "direct");
    const oldOpen = oldSocket.onopen;
    manager.stop();
    manager.start();
    await waitFor(() => opened.length === 2);
    oldOpen?.();
    await flush();

    expect(oldSocket.authMessage).toBeUndefined();
    const currentSocket = opened[1]?.socket;
    currentSocket?.open();
    await waitFor(() => manager.state() === "connected");
    expect(opened).toHaveLength(2);
    manager.stop();
  });

  test("calls reject with not_connected without a direct route and use direct HTTP while reconnecting", async () => {
    const secureOnly: Machine = { ...machine, routes: {} };
    const noRouteManager = createConnectionManager({
      machine: secureOnly,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      openRoute: () => {
        throw new Error("no route expected");
      },
    });
    await expect(noRouteManager.calls().health()).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 503,
      code: "not_connected",
      message: "Not connected to Mac.",
    });

    const requests: { url: string; authorization: string | null }[] = [];
    await withFetch(
      async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({ ok: true });
      },
      async () => {
        const directManager = createConnectionManager({
          machine,
          secrets: createMemorySecrets([[machine.id, "secret-token"]]),
          core: createCoreStore().getState(),
          openRoute: () => routeConnection(new FakeSocket()),
        });
        await expect(directManager.calls().health()).resolves.toEqual({ ok: true });
      },
    );
    expect(requests).toEqual([
      { url: `${directUrl}/api/health`, authorization: "Bearer secret-token" },
    ]);
  });

  test("the calls facade remains stable and delegates to the connected route", async () => {
    const socket = new FakeSocket();
    const requests: string[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: createCoreStore().getState(),
      openRoute: () =>
        routeConnection(socket, async (input) => {
          requests.push(String(input));
          return Response.json({ connected: true });
        }),
    });
    const calls = manager.calls();
    manager.start();
    await flush();
    socket.open();
    await waitFor(() => manager.state() === "connected");

    expect(manager.calls()).toBe(calls);
    await expect(calls.health()).resolves.toEqual({ connected: true });
    expect(requests).toEqual([`${directUrl}/api/health`]);
    manager.stop();
  });

  test("resets the watchdog on heartbeat bytes and closes the socket before retry", async () => {
    const clock = new FakeClock();
    const opened: OpenedSocket[] = [];
    const manager = createManager(machine, createCoreStore(), opened, clock);
    manager.start();
    await waitFor(() => opened.length === 1);
    const first = socketFor(opened, "direct");
    first.open();
    await waitFor(() => manager.state() === "connected");
    clock.advance(30_000);
    first.sendSubscriptionNotification(11, "heartbeat", {});
    clock.advance(44_999);
    await flush();
    expect(manager.state()).toBe("connected");
    clock.advance(1);

    expect(manager.state()).toBe("reconnecting");
    expect(first.closeRequests).toEqual([{ code: 1000, reason: "reconnecting" }]);
    manager.stop();
  });
});

interface OpenedSocket {
  route: MachineRoute;
  socket: FakeSocket;
}

interface FakeSocketOptions {
  rejectCode?: number;
  authReply?: Record<string, unknown>;
}

function setupConnected() {
  const clock = new FakeClock();
  const coreStore = createCoreStore();
  const socket = new FakeSocket();
  const manager = createConnectionManager({
    machine,
    secrets: createMemorySecrets([[machine.id, "secret-token"]]),
    core: coreStore.getState(),
    openRoute: () => routeConnection(socket),
    clock,
  });
  return { manager, socket, coreStore };
}

function createManager(
  currentMachine: Machine,
  coreStore: ReturnType<typeof createCoreStore>,
  opened: OpenedSocket[],
  clock = new FakeClock(),
  onRoutes?: (routes: unknown) => void,
  socketOptions: Partial<Record<"direct" | "secure", FakeSocketOptions>> = {},
): ReturnType<typeof createConnectionManager> {
  return createConnectionManager({
    machine: currentMachine,
    secrets: createMemorySecrets([[currentMachine.id, "secret-token"]]),
    core: coreStore.getState(),
    ...(onRoutes ? { updateRoutes: (_id: string, routes) => onRoutes(routes) } : {}),
    openRoute: (route) => {
      const socket = new FakeSocket(socketOptions[route.kind]);
      opened.push({ route, socket });
      return routeConnection(socket);
    },
    clock,
  });
}

function socketFor(opened: readonly OpenedSocket[], kind: MachineRoute["kind"]): FakeSocket {
  const result = opened.find(({ route }) => route.kind === kind)?.socket;
  if (!result) throw new Error(`No ${kind} fake socket is open`);
  return result;
}

function withSecureRoute(): Machine {
  return {
    ...machine,
    routes: {
      direct: directUrl,
      secure: { url: secureUrl, key: pinnedKey },
    },
  };
}

function routeConnection(
  socket: FakeSocket,
  fetcher: BridgeFetch = async () => Response.json({}),
): RouteConnection {
  return { socket, fetch: fetcher };
}

function createLifecycleMachineState(initial: Machine) {
  const listeners = new Set<() => void>();
  const persist = { rehydrate: async () => {}, hasHydrated: () => true };
  let state = { activeId: initial.id, machines: { [initial.id]: initial } };
  return {
    store: {
      persist,
      getState: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    getMachine(id: string) {
      return state.machines[id];
    },
    updateRoutes(id: string, routes: Machine["routes"]) {
      const current = state.machines[id];
      if (!current) return;
      state = { ...state, machines: { ...state.machines, [id]: { ...current, routes } } };
      for (const listener of listeners) listener();
    },
  };
}

async function connect(manager: ReturnType<typeof createConnectionManager>, socket: FakeSocket) {
  manager.start();
  await flush();
  socket.open();
  await waitFor(() => manager.state() === "connected");
}

class FakeSocket implements Socket {
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly core: FakeCore;
  readonly closeRequests: { code: number; reason: string }[] = [];
  authMessage: unknown;
  private readonly options: FakeSocketOptions;

  constructor(options: FakeSocketOptions = {}) {
    this.options = options;
    this.core = new FakeCore((bytes) => this.onmessage?.(bytes));
    this.core.answer = (method) => {
      if (method !== "doc.get") return undefined;
      const count = this.core.calls.filter((call) => call === "doc.get").length;
      return {
        value: { spaces: [{ id: "space", name: `space-${count}`, folder: null, tabs: [] }] },
        version: count,
      };
    };
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.authMessage = JSON.parse(data);
      if (this.options.rejectCode !== undefined) {
        this.serverClose(this.options.rejectCode);
        return;
      }
      this.onmessage?.(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          ok: true,
          role: "control",
          machine: { id: machine.id, name: machine.name },
          ...this.options.authReply,
        }),
      );
      return;
    }
    this.core.write(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.closeRequests.push({ code, reason });
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(code: number): void {
    this.onclose?.({ code });
  }

  sendSubscriptionNotification(seq: number, method: string, params: Record<string, unknown>): void {
    const channel = this.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("FakeCore has no event subscription channel");
    this.core.send({
      channel,
      kind: FrameKind.Data,
      payload: line({ jsonrpc: "2.0", method, params: { seq, ...params } }),
    });
  }
}

class FakeClock implements Clock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.time = timer.at;
      this.timers.delete(id);
      timer.callback();
    }
    this.time = end;
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await flush();
  }
  expect(predicate()).toBe(true);
}

async function withFetch<T>(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  action: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher as typeof globalThis.fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

let connectionWebSocketTask = Promise.resolve();

async function withMemoryConnectionWebSocket<T>(
  action: (identity: StaticKeyPair) => Promise<T>,
): Promise<T> {
  const previous = connectionWebSocketTask;
  let release!: () => void;
  connectionWebSocketTask = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const host = globalThis as unknown as { WebSocket: typeof WebSocket };
  const original = host.WebSocket;
  const identity = generateStaticKeyPair();
  MemoryConnectionWebSocket.identity = identity;
  MemoryConnectionWebSocket.onServerSession = undefined;
  MemoryConnectionWebSocket.instances = [];
  host.WebSocket = MemoryConnectionWebSocket as unknown as typeof WebSocket;
  try {
    return await action(identity);
  } finally {
    MemoryConnectionWebSocket.onServerSession = undefined;
    MemoryConnectionWebSocket.instances = [];
    host.WebSocket = original;
    release();
  }
}

class MemoryConnectionWebSocket {
  static identity: StaticKeyPair;
  static onServerSession: ((session: SecureSession) => void) | undefined;
  static instances: MemoryConnectionWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  binaryType: BinaryType = "arraybuffer";
  readonly clientDuplex: DuplexSocket;
  serverSession: SecureSession | undefined;
  closed = false;

  constructor(_url: string) {
    const [client, server] = createMemoryDuplexPair();
    this.clientDuplex = client;
    MemoryConnectionWebSocket.instances.push(this);
    client.onMessage((bytes) => {
      this.onmessage?.({ data: bytes.slice().buffer } as MessageEvent);
    });
    client.onClose((code, reason) => {
      this.closed = true;
      this.onclose?.({ code, reason } as CloseEvent);
    });
    void openResponder(server, { localStatic: MemoryConnectionWebSocket.identity }).then(
      (session) => {
        this.serverSession = session;
        MemoryConnectionWebSocket.onServerSession?.(session);
      },
      () => {},
    );
    queueMicrotask(() => this.onopen?.({} as Event));
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.clientDuplex.send(bytes);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.clientDuplex.close(code, reason);
  }
}

function terminal(address: string): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: "/repo",
    labels: {},
    pid: 1,
    records: {},
    reported: true,
    rows: 24,
    screen: "exact",
    state: "live",
  };
}
