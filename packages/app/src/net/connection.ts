import {
  type AttachHandle,
  type AttachOptions,
  createClient,
  type HcClient,
  utf8Encode,
} from "@herdr-mobile/hc-client";
import {
  type AuthReply,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WS_CLOSE_CODES,
  type HcEvent,
  type HcMethod,
  type HcParams,
  type HcResult,
  type JsonValue,
  parseHerdrAppDoc,
} from "@herdr-mobile/protocol";
import type { ConnectionState, CoreStore } from "../store/core.ts";
import type { Machine } from "../store/machines.ts";
import type { Secrets } from "../store/secrets.ts";
import { type Socket, type SocketFactory, webSocketFactory } from "./socket.ts";

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const WATCHDOG_MS = 45_000;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ConnectionCore = Pick<
  CoreStore,
  "setConnection" | "setSnapshot" | "applyEvent" | "setLayout"
>;

export interface ConnectionManagerOptions {
  machine: Machine;
  secrets: Secrets;
  core: ConnectionCore;
  socketFactory?: SocketFactory;
  clock?: Clock;
}

/** Public connection surface used by screens and boot. */
export interface ConnectionManager {
  start(): void;
  stop(): void;
  attach(
    address: string,
    options: AttachOptions & { observe: boolean; cols: number; rows: number },
  ): Promise<AttachHandle>;
  call<M extends HcMethod>(method: M, params: HcParams<M>): Promise<HcResult<M>>;
  state(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
}

/** One hc-client session over the paired bridge's authenticated WebSocket. */
export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  return new Manager(options);
}

class Manager implements ConnectionManager {
  private readonly machine: Machine;
  private readonly secrets: Secrets;
  private readonly core: ConnectionCore;
  private readonly socketFactory: SocketFactory;
  private readonly clock: Clock;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private stateValue: ConnectionState = "offline";
  private started = false;
  private runId = 0;
  private attemptId = 0;
  private finishedAttemptId: number | undefined;
  private attemptCount = 0;
  private socket: Socket | undefined;
  private client: HcClient | undefined;
  private watchdog: unknown;
  private reconnect: unknown;
  private incoming: Promise<void> = Promise.resolve();

  constructor(options: ConnectionManagerOptions) {
    this.machine = options.machine;
    this.secrets = options.secrets;
    this.core = options.core;
    this.socketFactory = options.socketFactory ?? webSocketFactory;
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attemptCount = 0;
    const run = ++this.runId;
    this.setState("connecting");
    this.core.setConnection(this.machine.id, "connecting");
    void this.connect(run);
  }

  stop(): void {
    this.started = false;
    this.runId += 1;
    this.clearTimers();
    this.closeCurrent("connection stopped");
    this.setState("offline");
    this.core.setConnection(this.machine.id, "offline");
  }

  attach(
    address: string,
    options: AttachOptions & { observe: boolean; cols: number; rows: number },
  ): Promise<AttachHandle> {
    const client = this.readyClient();
    if (!client) return Promise.reject(new Error("Connection is not connected"));
    const { observe, cols, rows, onData } = options;
    return client.attach({ terminal: address, observe, cols, rows }, { onData });
  }

  call<M extends HcMethod>(method: M, params: HcParams<M>): Promise<HcResult<M>> {
    const client = this.readyClient();
    if (!client) return Promise.reject(new Error("Connection is not connected"));
    return client.call(method, params);
  }

  state(): ConnectionState {
    return this.stateValue;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  private readyClient(): HcClient | undefined {
    return this.stateValue === "connected" ? this.client : undefined;
  }

  private async connect(run: number): Promise<void> {
    if (!this.started || run !== this.runId) return;
    const attempt = ++this.attemptId;
    if (this.stateValue === "reconnecting") {
      this.setState("connecting");
      this.core.setConnection(this.machine.id, "connecting");
    }

    let token: string | null;
    try {
      token = await this.secrets.get(this.machine.id);
    } catch (error) {
      this.scheduleReconnect(run, attempt, error);
      return;
    }
    if (!this.isCurrent(run, attempt)) return;
    if (!token) {
      this.unauthorized(run, attempt);
      return;
    }

    if (this.socket && !this.closeCurrent("restarting connection")) {
      this.scheduleReconnect(run, attempt, new Error("Previous WebSocket did not close"));
      return;
    }

    let socket: Socket;
    try {
      socket = this.socketFactory(webSocketUrl(this.machine.url));
    } catch (error) {
      this.scheduleReconnect(run, attempt, error);
      return;
    }
    this.socket = socket;
    this.incoming = Promise.resolve();

    socket.onopen = () => {
      if (!this.isSocketCurrent(run, attempt, socket)) return;
      this.armWatchdog(run, attempt, socket);
      try {
        socket.send(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, token }));
      } catch (error) {
        this.scheduleReconnect(run, attempt, error);
      }
    };
    socket.onmessage = (data) => {
      if (!this.isSocketCurrent(run, attempt, socket)) return;
      this.armWatchdog(run, attempt, socket);
      this.incoming = this.incoming
        .then(async () => {
          if (this.isSocketCurrent(run, attempt, socket)) {
            await this.receive(data, run, attempt, socket);
          }
        })
        .catch((error: unknown) => this.scheduleReconnect(run, attempt, error));
    };
    socket.onclose = (event) => {
      if (!this.isSocketCurrent(run, attempt, socket)) return;
      if (event.code === BRIDGE_WS_CLOSE_CODES.BAD_TOKEN) this.unauthorized(run, attempt);
      else this.scheduleReconnect(run, attempt, new Error(`WebSocket closed (${event.code})`));
    };
    socket.onerror = () => {
      if (this.isSocketCurrent(run, attempt, socket)) {
        this.scheduleReconnect(run, attempt, new Error("WebSocket transport failed"));
      }
    };
    this.armWatchdog(run, attempt, socket);
  }

  private async receive(
    data: unknown,
    run: number,
    attempt: number,
    socket: Socket,
  ): Promise<void> {
    if (!this.client) {
      if (typeof data !== "string") throw new Error("Bridge authentication reply must be text");
      const reply = parseAuthReply(data);
      if (!reply) throw new Error("Bridge returned an invalid authentication reply");
      const client = createClient({
        write: (bytes) => socket.send(bytes),
        requestTransportClose: () => socket.close(),
      });
      this.client = client;
      void client.closed.then((cause) => {
        if (this.isSocketCurrent(run, attempt, socket) && this.client === client) {
          this.scheduleReconnect(run, attempt, cause);
        }
      });
      void this.bootstrap(client, run, attempt, socket).catch((error: unknown) => {
        this.scheduleReconnect(run, attempt, error);
      });
      return;
    }

    const bytes = await toBytes(data);
    if (!this.isSocketCurrent(run, attempt, socket)) return;
    this.client.feed(bytes);
  }

  private async bootstrap(
    client: HcClient,
    run: number,
    attempt: number,
    socket: Socket,
  ): Promise<void> {
    await client.hello({ framed: true });
    if (!this.isSocketCurrent(run, attempt, socket)) return;

    let receivedSnapshot = false;
    const subscription = await client.subscribeEvents(
      {},
      {
        onSnapshot: (snapshot) => {
          this.core.setSnapshot(this.machine.id, snapshot.terminals, this.clock.now());
          if (receivedSnapshot) void this.refetchLayout(client, run, attempt, socket);
          receivedSnapshot = true;
        },
        onEvent: (event) => {
          this.core.applyEvent(this.machine.id, event, this.clock.now());
          if (isHerdrAppDocEvent(event)) void this.refetchLayout(client, run, attempt, socket);
        },
      },
    );
    if (!this.isSocketCurrent(run, attempt, socket)) return;
    void subscription.closed.then((end) => {
      if (this.isSocketCurrent(run, attempt, socket) && this.client === client) {
        this.scheduleReconnect(run, attempt, new Error(`Event stream ended (${end.kind})`));
      }
    });

    await this.refetchLayout(client, run, attempt, socket);
    if (!this.isSocketCurrent(run, attempt, socket)) return;
    this.attemptCount = 0;
    this.setState("connected");
    this.core.setConnection(this.machine.id, "connected");
  }

  private async refetchLayout(
    client: HcClient,
    run: number,
    attempt: number,
    socket: Socket,
  ): Promise<void> {
    try {
      const result = await client.call("doc.get", { name: "herdr-app" });
      if (!this.isSocketCurrent(run, attempt, socket)) return;
      this.core.setLayout(this.machine.id, parseHerdrAppDoc(result.value as JsonValue));
    } catch {
      if (this.isSocketCurrent(run, attempt, socket))
        this.core.setLayout(this.machine.id, undefined);
    }
  }

  private scheduleReconnect(run: number, attempt: number, _cause: unknown): void {
    if (!this.finishAttempt(run, attempt)) return;
    this.clearWatchdog();
    this.clearReconnect();
    this.setState("reconnecting");
    this.core.setConnection(this.machine.id, "reconnecting");
    if (!this.closeCurrent("reconnecting")) return;
    const delay =
      RECONNECT_DELAYS[Math.min(this.attemptCount, RECONNECT_DELAYS.length - 1)] ?? 15_000;
    this.attemptCount += 1;
    this.reconnect = this.clock.setTimeout(() => {
      this.reconnect = undefined;
      if (this.started && run === this.runId) void this.connect(run);
    }, delay);
  }

  private unauthorized(run: number, attempt: number): void {
    if (!this.finishAttempt(run, attempt)) return;
    this.started = false;
    this.runId += 1;
    this.clearTimers();
    this.closeCurrent("unauthorized");
    this.setState("unauthorized");
    this.core.setConnection(this.machine.id, "unauthorized");
  }

  private armWatchdog(run: number, attempt: number, socket: Socket): void {
    this.clearWatchdog();
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = undefined;
      if (this.isSocketCurrent(run, attempt, socket)) {
        this.scheduleReconnect(run, attempt, new Error("WebSocket heartbeat timed out"));
      }
    }, WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog === undefined) return;
    this.clock.clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private clearTimers(): void {
    this.clearWatchdog();
    this.clearReconnect();
  }

  private clearReconnect(): void {
    if (this.reconnect !== undefined) {
      this.clock.clearTimeout(this.reconnect);
      this.reconnect = undefined;
    }
  }

  private closeCurrent(reason: string): boolean {
    const socket = this.socket;
    if (socket) {
      try {
        socket.close(1000, reason);
      } catch {
        // Keep the transport references if the close request was rejected.
        return false;
      }
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      this.socket = undefined;
    }
    const client = this.client;
    this.client = undefined;
    client?.end(new Error(reason));
    return true;
  }

  private finishAttempt(run: number, attempt: number): boolean {
    if (!this.isCurrent(run, attempt)) return false;
    this.finishedAttemptId = attempt;
    return true;
  }

  private isCurrent(run: number, attempt: number): boolean {
    return (
      this.started &&
      run === this.runId &&
      attempt === this.attemptId &&
      attempt !== this.finishedAttemptId
    );
  }

  private isSocketCurrent(run: number, attempt: number, socket: Socket): boolean {
    return this.isCurrent(run, attempt) && this.socket === socket;
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (state: ConnectionState) => void): void {
    try {
      listener(this.stateValue);
    } catch {
      // Observers cannot interrupt protocol processing.
    }
  }
}

function webSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseAuthReply(value: string): AuthReply | undefined {
  let message: unknown;
  try {
    message = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  const machine = record.machine;
  if (typeof machine !== "object" || machine === null || Array.isArray(machine)) return undefined;
  const core = machine as Record<string, unknown>;
  return record.v === BRIDGE_PROTOCOL_VERSION &&
    record.ok === true &&
    (record.role === "watch" || record.role === "control") &&
    typeof core.id === "string" &&
    typeof core.name === "string"
    ? (record as unknown as AuthReply)
    : undefined;
}

function isHerdrAppDocEvent(event: HcEvent): boolean {
  if (event.type !== "doc" || typeof event.data !== "object" || event.data === null) return false;
  return (event.data as Record<string, JsonValue>).name === "herdr-app";
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return utf8Encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Unsupported WebSocket message data");
}
