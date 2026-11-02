/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { FakeCore, line } from "@herdr-mobile/hc-client/testing";
import { BRIDGE_PROTOCOL_VERSION, FrameKind, type Terminal } from "@herdr-mobile/protocol";
import { createCoreStore } from "../store/core.ts";
import { createMemorySecrets } from "../store/memory.ts";
import { type Clock, createConnectionManager } from "./connection.ts";
import type { Socket } from "./socket.ts";

const machine = {
  id: "machine-1",
  name: "Mac",
  url: "https://mac.tailnet.ts.net",
  role: "control" as const,
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
      socketFactory: (url) => {
        expect(url).toBe("wss://mac.tailnet.ts.net/ws");
        return socket;
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
    expect(coreStore.getState().machines[machine.id]?.terminals.t1?.address).toBe("t1");
    expect(coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name).toBe("space-1");
    expect(states).toContain("connected");

    socket.sendSubscriptionNotification(11, "event", {
      type: "turn",
      terminal: "t1",
      data: { turn: 2 },
    });
    await waitFor(() => coreStore.getState().machines[machine.id]?.terminals.t1?.turn === 2);
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

    socket.sendSubscriptionNotification(12, "missed", {
      terminals: [terminal("t2")],
    });
    await waitFor(
      () => coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name === "space-3",
    );
    expect(Object.keys(coreStore.getState().machines[machine.id]?.terminals ?? {})).toEqual(["t2"]);
    expect(coreStore.getState().machines[machine.id]?.layout?.spaces[0]?.name).toBe("space-3");
  });

  test("starts reconnect backoff at 1s then 2s", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const sockets: FakeSocket[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    });

    manager.start();
    await flush();
    sockets[0]?.open();
    await waitFor(() => manager.state() === "connected");
    sockets[0]?.serverClose(1006);
    expect(manager.state()).toBe("reconnecting");
    clock.advance(999);
    await flush();
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => sockets.length === 2);
    sockets[1]?.serverClose(1006);
    clock.advance(1_999);
    await flush();
    expect(sockets).toHaveLength(2);
    clock.advance(1);
    await waitFor(() => sockets.length === 3);

    sockets[2]?.open();
    await waitFor(() => manager.state() === "connected");
    manager.stop();
  });

  test("a disconnect while hello is pending schedules exactly one retry", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const sockets: FakeSocket[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    });

    manager.start();
    await waitFor(() => sockets.length === 1);
    const first = sockets[0] as FakeSocket;
    first.core.hold("hello");
    first.open();
    await waitFor(() => first.core.calls.includes("hello"));
    first.serverClose(1006);

    expect(manager.state()).toBe("reconnecting");
    clock.advance(999);
    await flush();
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => sockets.length === 2);
    const retry = sockets[1] as FakeSocket;
    retry.open();
    await waitFor(() => manager.state() === "connected");
    clock.advance(20_000);
    await flush();

    expect(sockets).toHaveLength(2);
    manager.stop();
  });

  test("caps reconnect backoff at 15s after 1s, 2s, 4s and 8s", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const sockets: FakeSocket[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    });

    manager.start();
    await waitFor(() => sockets.length === 1);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const current = sockets[sockets.length - 1] as FakeSocket;
      current.serverClose(1006);
      const previousCount = sockets.length;
      clock.advance(delay - 1);
      await flush();
      expect(sockets).toHaveLength(previousCount);
      clock.advance(1);
      await waitFor(() => sockets.length === previousCount + 1);
    }

    manager.stop();
  });

  test("resets the watchdog on heartbeat bytes and closes the old socket before retry", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const sockets: FakeSocket[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    });

    manager.start();
    await waitFor(() => sockets.length === 1);
    const first = sockets[0] as FakeSocket;
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
    clock.advance(999);
    await flush();
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => sockets.length === 2);
    expect(first.closeRequests).toHaveLength(1);
    const retry = sockets[1] as FakeSocket;
    retry.open();
    await waitFor(() => manager.state() === "connected");
    manager.stop();
  });

  test("stop cancels retry and watchdog timers so a later start begins cleanly", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const sockets: FakeSocket[] = [];
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    });

    manager.start();
    await waitFor(() => sockets.length === 1);
    (sockets[0] as FakeSocket).serverClose(1006);
    manager.stop();
    clock.advance(60_000);
    await flush();
    expect(sockets).toHaveLength(1);

    manager.start();
    await waitFor(() => sockets.length === 2);
    const second = sockets[1] as FakeSocket;
    second.open();
    await waitFor(() => manager.state() === "connected");
    manager.stop();
    clock.advance(60_000);
    await flush();
    expect(sockets).toHaveLength(2);

    manager.start();
    await waitFor(() => sockets.length === 3);
    manager.stop();
  });

  test("maps bridge close code 4401 to unauthorized without reconnecting", async () => {
    const clock = new FakeClock();
    const coreStore = createCoreStore();
    const socket = new FakeSocket({ rejectAuth: true });
    const manager = createConnectionManager({
      machine,
      secrets: createMemorySecrets([[machine.id, "secret-token"]]),
      core: coreStore.getState(),
      socketFactory: () => socket,
      clock,
    });

    manager.start();
    await flush();
    socket.open();
    await waitFor(() => manager.state() === "unauthorized");
    expect(coreStore.getState().machines[machine.id]?.connection).toBe("unauthorized");
    clock.advance(60_000);
    await flush();
    expect(manager.state()).toBe("unauthorized");
  });
});

function setupConnected() {
  const clock = new FakeClock();
  const coreStore = createCoreStore();
  const socket = new FakeSocket();
  const manager = createConnectionManager({
    machine,
    secrets: createMemorySecrets([[machine.id, "secret-token"]]),
    core: coreStore.getState(),
    socketFactory: () => socket,
    clock,
  });
  return { manager, socket, coreStore };
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

  constructor(options: { rejectAuth?: boolean } = {}) {
    this.core = new FakeCore((bytes) => this.onmessage?.(bytes));
    this.core.answer = (method) => {
      if (method !== "doc.get") return undefined;
      const count = this.core.calls.filter((call) => call === "doc.get").length;
      return {
        value: { spaces: [{ id: "space", name: `space-${count}`, folder: null, tabs: [] }] },
        version: count,
      };
    };
    this.rejectAuth = options.rejectAuth ?? false;
  }

  private readonly rejectAuth: boolean;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.authMessage = JSON.parse(data);
      if (this.rejectAuth) {
        this.serverClose(4401);
        return;
      }
      this.onmessage?.(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          ok: true,
          role: "control",
          machine: { id: machine.id, name: machine.name },
        }),
      );
      return;
    }
    this.core.write(data);
  }

  close(code = 1000, reason = "closed"): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`Invalid WebSocket client close code: ${code}`);
    }
    this.closeRequests.push({ code, reason });
    this.onclose?.({ code, reason });
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
