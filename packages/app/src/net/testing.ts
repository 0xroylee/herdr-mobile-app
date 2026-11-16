import { expect } from "bun:test";
import { FakeCore, line } from "@herdr-mobile/hc-client/testing";
import { BRIDGE_PROTOCOL_VERSION, FrameKind, TASKS_DOC_NAME } from "@herdr-mobile/protocol";
import type { createCoreStore } from "../store/core.ts";
import type { Machine } from "../store/machines.ts";
import { createMemorySecrets } from "../store/memory.ts";
import type { BridgeFetch } from "./bridge-api.ts";
import { type Clock, createConnectionManager } from "./connection.ts";
import type { MachineRoute, RouteConnection } from "./route-opener.ts";
import type { Socket } from "./socket.ts";

export interface OpenedSocket {
  route: MachineRoute;
  socket: FakeSocket;
}

export interface FakeSocketOptions {
  rejectCode?: number;
  authReply?: Record<string, unknown>;
  machine?: Pick<Machine, "id" | "name">;
}

export function createManager(
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
      const socket = new FakeSocket({ ...socketOptions[route.kind], machine: currentMachine });
      opened.push({ route, socket });
      return routeConnection(socket);
    },
    clock,
  });
}

export function routeConnection(
  socket: FakeSocket,
  fetcher: BridgeFetch = async () => Response.json({}),
): RouteConnection {
  return { socket, fetch: fetcher };
}

export async function connect(
  manager: ReturnType<typeof createConnectionManager>,
  socket: FakeSocket,
): Promise<void> {
  manager.start();
  await flush();
  socket.open();
  await waitFor(() => manager.state() === "connected");
}

export class FakeSocket implements Socket {
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly core: FakeCore;
  readonly docGets: string[] = [];
  readonly closeRequests: { code: number; reason: string }[] = [];
  authMessage: unknown;
  tasksResponse: unknown = { v: 1, tasks: {} };
  private readonly options: FakeSocketOptions;

  constructor(options: FakeSocketOptions = {}) {
    this.options = options;
    this.core = new FakeCore((bytes) => this.onmessage?.(bytes));
    this.core.answer = (method, params) => {
      if (method !== "doc.get") return undefined;
      const name = String(params.name);
      this.docGets.push(name);
      if (name === TASKS_DOC_NAME) {
        const count = this.docGets.filter((docName) => docName === TASKS_DOC_NAME).length;
        return { value: this.tasksResponse, version: count };
      }
      const count = this.docGets.filter((docName) => docName === "herdr-app").length;
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
          machine: this.options.machine ?? { id: "machine-1", name: "Mac" },
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

export class FakeClock implements Clock {
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

export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await flush();
  }
  expect(predicate()).toBe(true);
}
