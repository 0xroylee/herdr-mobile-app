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
import type { Machine, MachineRoutes } from "../store/machines.ts";
import type { Secrets } from "../store/secrets.ts";
import { BridgeApiError, createBridgeApi } from "./bridge-api.ts";
import {
  type BridgeCalls,
  bindBridgeCalls,
  lazyCalls,
  unavailableBridgeCalls,
} from "./bridge-calls.ts";
import {
  defaultRouteOpener,
  type RouteConnection,
  type RouteOpener,
  routesOf,
} from "./route-opener.ts";
import type { Socket } from "./socket.ts";

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
  openRoute?: RouteOpener;
  /** Persist authenticated route changes without replacing this manager; the next attempt reads them. */
  updateRoutes?: (id: string, routes: MachineRoutes) => void;
  /** Read the latest stored machine routes at the start of each connection attempt. */
  getMachine?: (id: string) => Machine | undefined;
  clock?: Clock;
}

interface Candidate {
  route: ReturnType<typeof routesOf>[number];
  connection: RouteConnection;
  state: "pending" | "won" | "failed";
  failureCode?: number;
  incoming: Promise<void>;
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
  calls(): BridgeCalls;
  state(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
}

/** One hc-client session over the first authenticated route to the paired bridge. */
export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  return new Manager(options);
}

class Manager implements ConnectionManager {
  private machine: Machine;
  private readonly secrets: Secrets;
  private readonly core: ConnectionCore;
  private readonly openRoute: RouteOpener;
  private readonly updateRoutes: ((id: string, routes: MachineRoutes) => void) | undefined;
  private readonly getMachine: ((id: string) => Machine | undefined) | undefined;
  private readonly clock: Clock;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly callsFacade: BridgeCalls;
  private stateValue: ConnectionState = "offline";
  private started = false;
  private runId = 0;
  private attemptId = 0;
  private finishedAttemptId: number | undefined;
  private attemptCount = 0;
  private candidates: Candidate[] = [];
  private candidateFailures: number[] = [];
  private winner: Candidate | undefined;
  private socket: Socket | undefined;
  private client: HcClient | undefined;
  private connectedCalls: BridgeCalls | undefined;
  private watchdog: unknown;
  private reconnect: unknown;

  constructor(options: ConnectionManagerOptions) {
    this.machine = { ...options.machine, routes: { ...options.machine.routes } };
    this.secrets = options.secrets;
    this.core = options.core;
    this.openRoute = options.openRoute ?? defaultRouteOpener;
    this.updateRoutes = options.updateRoutes;
    this.getMachine = options.getMachine;
    this.clock = options.clock ?? systemClock;
    this.callsFacade = lazyCalls(() => Promise.resolve(this.callsForCurrentState()));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attemptCount = 0;
    const run = ++this.runId;
    this.setState("connecting");
    if (!this.isRunActive(run)) return;
    this.core.setConnection(this.machine.id, "connecting");
    if (!this.isRunActive(run)) return;
    void this.connect(run);
  }

  stop(): void {
    this.started = false;
    const stoppedRun = ++this.runId;
    this.clearTimers();
    this.closeCurrent("connection stopped");
    if (this.started || this.runId !== stoppedRun) return;
    this.setState("offline");
    if (this.started || this.runId !== stoppedRun) return;
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

  calls(): BridgeCalls {
    return this.callsFacade;
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

  private callsForCurrentState(): BridgeCalls {
    if (this.stateValue === "connected" && this.connectedCalls) return this.connectedCalls;
    if (this.machine.routes.direct) {
      const api = createBridgeApi((input, init) => globalThis.fetch(input, init));
      return lazyCalls(async () => {
        const token = await this.secrets.get(this.machine.id);
        if (!token) {
          throw new BridgeApiError(
            503,
            "token_unavailable",
            `The access token for ${this.machine.name} is unavailable.`,
          );
        }
        return bindBridgeCalls(api, this.machine.routes.direct as string, token);
      });
    }
    return unavailableBridgeCalls(`Not connected to ${this.machine.name}.`);
  }

  private async connect(run: number): Promise<void> {
    if (!this.started || run !== this.runId) return;
    const attempt = ++this.attemptId;
    const storedMachine = this.getMachine?.(this.machine.id);
    if (storedMachine?.id === this.machine.id) this.machine = copyMachine(storedMachine);
    if (!this.isCurrent(run, attempt)) return;
    if (this.stateValue === "reconnecting") {
      this.setState("connecting");
      if (!this.isCurrent(run, attempt)) return;
      this.core.setConnection(this.machine.id, "connecting");
      if (!this.isCurrent(run, attempt)) return;
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

    if (this.candidates.length > 0 && !this.closeCurrent("restarting connection")) {
      this.scheduleReconnect(run, attempt, new Error("Previous WebSocket did not close"));
      return;
    }
    if (!this.isCurrent(run, attempt)) return;

    this.candidateFailures = [];
    this.winner = undefined;
    this.connectedCalls = undefined;
    const routes = routesOf(this.machine);
    for (const route of routes) {
      let connection: RouteConnection;
      try {
        connection = this.openRoute(route);
      } catch {
        if (!this.isCurrent(run, attempt)) return;
        this.candidateFailures.push(1006);
        continue;
      }
      if (!this.isCurrent(run, attempt)) {
        try {
          connection.socket.close(1000, "connection stopped");
        } catch {
          // The run already ended while the route adapter was opening.
        }
        return;
      }
      this.candidates.push({ route, connection, state: "pending", incoming: Promise.resolve() });
    }

    if (this.candidates.length === 0) {
      this.finishFailedRace(run, attempt);
      return;
    }

    this.armWatchdog(run, attempt);
    for (const candidate of this.candidates) {
      const socket = candidate.connection.socket;
      socket.onopen = () => {
        if (!this.isCandidateCurrent(run, attempt, candidate)) return;
        try {
          socket.send(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, token }));
        } catch {
          this.failCandidate(run, attempt, candidate, 1006);
        }
      };
      socket.onmessage = (data) => {
        if (!this.isCandidateCurrent(run, attempt, candidate)) return;
        this.armWatchdog(run, attempt);
        candidate.incoming = candidate.incoming
          .then(async () => {
            if (this.isCandidateCurrent(run, attempt, candidate)) {
              await this.receive(data, run, attempt, candidate);
            }
          })
          .catch((error: unknown) => {
            if (candidate === this.winner) this.scheduleReconnect(run, attempt, error);
            else this.failCandidate(run, attempt, candidate, 1002);
          });
      };
      socket.onclose = (event) => {
        if (!this.isCandidateCurrent(run, attempt, candidate)) return;
        if (candidate === this.winner) {
          if (event.code === BRIDGE_WS_CLOSE_CODES.BAD_TOKEN) this.unauthorized(run, attempt);
          else this.scheduleReconnect(run, attempt, new Error(`WebSocket closed (${event.code})`));
          return;
        }
        this.failCandidate(run, attempt, candidate, event.code);
      };
      socket.onerror = () => {
        if (this.isCandidateCurrent(run, attempt, candidate)) {
          if (candidate === this.winner) {
            this.scheduleReconnect(run, attempt, new Error("WebSocket transport failed"));
          } else {
            this.failCandidate(run, attempt, candidate, 1006);
          }
        }
      };
    }
  }

  private async receive(
    data: unknown,
    run: number,
    attempt: number,
    candidate: Candidate,
  ): Promise<void> {
    if (candidate !== this.winner) {
      if (candidate.state !== "pending") return;
      if (typeof data !== "string") {
        this.failCandidate(run, attempt, candidate, 1002);
        return;
      }
      const reply = parseAuthReply(data);
      if (!reply) {
        this.failCandidate(run, attempt, candidate, 1002);
        return;
      }
      this.winCandidate(run, attempt, candidate, reply);
      return;
    }

    const socket = candidate.connection.socket;
    if (!this.isSocketCurrent(run, attempt, socket) || !this.client) return;
    const bytes = await toBytes(data);
    if (!this.isSocketCurrent(run, attempt, socket)) return;
    this.client.feed(bytes);
  }

  private winCandidate(run: number, attempt: number, candidate: Candidate, reply: AuthReply): void {
    if (
      !this.isCandidateCurrent(run, attempt, candidate) ||
      candidate.state !== "pending" ||
      this.winner
    ) {
      return;
    }
    this.winner = candidate;
    candidate.state = "won";
    this.socket = candidate.connection.socket;
    this.updateMachineRoutes(candidate.route.kind, reply);
    if (!this.isCandidateCurrent(run, attempt, candidate)) return;
    this.closeLosers(candidate, "another route authenticated first");
    if (!this.isCandidateCurrent(run, attempt, candidate)) return;

    const socket = candidate.connection.socket;
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
    void this.bootstrap(client, run, attempt, candidate).catch((error: unknown) => {
      this.scheduleReconnect(run, attempt, error);
    });
  }

  private updateMachineRoutes(kind: "direct" | "secure", reply: AuthReply): void {
    const current = this.machine.routes;
    const advertised = reply.routes;
    const direct = advertised?.direct ?? current.direct;
    const secureUrl = advertised?.secure ?? current.secure?.url;
    const storedKey = current.secure?.key;
    const nextKey =
      reply.bridgeKey !== undefined && (kind === "direct" || storedKey === undefined)
        ? reply.bridgeKey
        : storedKey;
    const secure = secureUrl && nextKey ? { url: secureUrl, key: nextKey } : current.secure;
    const routes: MachineRoutes = {
      ...(direct === undefined ? {} : { direct }),
      ...(secure === undefined ? {} : { secure }),
    };
    if (sameRoutes(current, routes)) return;
    this.machine = { ...this.machine, routes };
    this.updateRoutes?.(this.machine.id, routes);
  }

  private closeLosers(winner: Candidate, reason: string): void {
    for (const candidate of this.candidates) {
      if (candidate === winner || candidate.state !== "pending") continue;
      candidate.state = "failed";
      this.detach(candidate.connection.socket);
      try {
        candidate.connection.socket.close(1000, reason);
      } catch {
        // The authenticated route can continue even if a losing close is refused.
      }
    }
    this.candidates = [winner];
  }

  private async bootstrap(
    client: HcClient,
    run: number,
    attempt: number,
    candidate: Candidate,
  ): Promise<void> {
    const socket = candidate.connection.socket;
    await client.hello({ framed: true });
    if (!this.isSocketCurrent(run, attempt, socket)) return;

    let receivedSnapshot = false;
    const subscription = await client.subscribeEvents(
      {},
      {
        onSnapshot: (snapshot) => {
          this.core.setSnapshot(this.machine.id, snapshot.terminals, this.clock.now());
          if (!this.isSocketCurrent(run, attempt, socket)) return;
          if (receivedSnapshot) void this.refetchLayout(client, run, attempt, socket);
          receivedSnapshot = true;
        },
        onEvent: (event) => {
          this.core.applyEvent(this.machine.id, event, this.clock.now());
          if (!this.isSocketCurrent(run, attempt, socket)) return;
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
    const token = await this.secrets.get(this.machine.id);
    if (!token || !this.isSocketCurrent(run, attempt, socket)) return;
    this.connectedCalls = bindBridgeCalls(
      createBridgeApi(candidate.connection.fetch),
      candidate.route.url,
      token,
    );
    this.setState("connected");
    if (!this.isSocketCurrent(run, attempt, socket)) return;
    this.core.setConnection(this.machine.id, "connected", candidate.route.kind);
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

  private failCandidate(run: number, attempt: number, candidate: Candidate, code: number): void {
    if (!this.isCandidateCurrent(run, attempt, candidate) || candidate.state !== "pending") return;
    candidate.state = "failed";
    candidate.failureCode = code;
    this.detach(candidate.connection.socket);
    try {
      candidate.connection.socket.close(1000, "route failed");
    } catch {
      // The candidate is already terminal for this race.
    }
    if (!this.isCurrent(run, attempt)) return;
    this.finishFailedRace(run, attempt);
  }

  private finishFailedRace(run: number, attempt: number): void {
    if (!this.isCurrent(run, attempt) || this.winner) return;
    if (this.candidates.some((candidate) => candidate.state === "pending")) return;
    const failureCodes = [
      ...this.candidateFailures,
      ...this.candidates.map((candidate) => candidate.failureCode ?? 1006),
    ];
    if (failureCodes.includes(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN)) {
      this.unauthorized(run, attempt);
      return;
    }
    if (failureCodes.includes(4003)) {
      this.identityChanged(run, attempt);
      return;
    }
    this.scheduleReconnect(run, attempt, new Error("All bridge routes failed"));
  }

  private scheduleReconnect(run: number, attempt: number, _cause: unknown): void {
    if (!this.finishAttempt(run, attempt)) return;
    this.clearWatchdog();
    this.clearReconnect();
    this.setState("reconnecting");
    if (!this.isRunActive(run)) return;
    this.core.setConnection(this.machine.id, "reconnecting");
    if (!this.isRunActive(run)) return;
    if (!this.closeCurrent("reconnecting")) return;
    if (!this.isRunActive(run)) return;
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
    const terminalRun = ++this.runId;
    this.clearTimers();
    this.closeCurrent("unauthorized");
    if (this.started || this.runId !== terminalRun) return;
    this.setState("unauthorized");
    if (this.started || this.runId !== terminalRun) return;
    this.core.setConnection(this.machine.id, "unauthorized");
  }

  private identityChanged(run: number, attempt: number): void {
    if (!this.finishAttempt(run, attempt)) return;
    this.started = false;
    const terminalRun = ++this.runId;
    this.clearTimers();
    this.closeCurrent("bridge identity changed");
    if (this.started || this.runId !== terminalRun) return;
    this.setState("identity_changed");
    if (this.started || this.runId !== terminalRun) return;
    this.core.setConnection(this.machine.id, "identity_changed");
  }

  private armWatchdog(run: number, attempt: number): void {
    this.clearWatchdog();
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = undefined;
      if (!this.isCurrent(run, attempt)) return;
      if (this.winner) {
        this.scheduleReconnect(run, attempt, new Error("WebSocket heartbeat timed out"));
        return;
      }
      for (const candidate of this.candidates) {
        if (candidate.state === "pending") candidate.failureCode = 1006;
        if (candidate.state === "pending") candidate.state = "failed";
      }
      this.finishFailedRace(run, attempt);
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
    let succeeded = true;
    for (const candidate of this.candidates) {
      this.detach(candidate.connection.socket);
      try {
        candidate.connection.socket.close(1000, reason);
      } catch {
        succeeded = false;
      }
    }
    this.candidates = [];
    this.winner = undefined;
    this.socket = undefined;
    const client = this.client;
    this.client = undefined;
    this.connectedCalls = undefined;
    client?.end(new Error(reason));
    return succeeded;
  }

  private detach(socket: Socket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
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

  private isRunActive(run: number): boolean {
    return this.started && run === this.runId;
  }

  private isCandidateCurrent(run: number, attempt: number, candidate: Candidate): boolean {
    return (
      this.isCurrent(run, attempt) &&
      this.candidates.includes(candidate) &&
      (candidate.state === "pending" || candidate === this.winner)
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

function sameRoutes(left: MachineRoutes, right: MachineRoutes): boolean {
  return (
    left.direct === right.direct &&
    left.secure?.url === right.secure?.url &&
    left.secure?.key === right.secure?.key
  );
}

function copyMachine(machine: Machine): Machine {
  return {
    ...machine,
    routes: {
      ...(machine.routes.direct === undefined ? {} : { direct: machine.routes.direct }),
      ...(machine.routes.secure === undefined
        ? {}
        : { secure: { url: machine.routes.secure.url, key: machine.routes.secure.key } }),
    },
  };
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
