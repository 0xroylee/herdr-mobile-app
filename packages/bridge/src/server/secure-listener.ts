import {
  type AuthReply,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WS_CLOSE_CODES,
  type DeviceRecordView,
  type PairReply,
} from "@herdr-mobile/protocol";
import {
  type DuplexSocket,
  HandshakeError,
  KeyMismatchError,
  openResponder,
  type SecureSession,
} from "@herdr-mobile/secure-channel";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";
import { createChannelApi } from "./channel-api.ts";
import type { IdentityKeyStore } from "./identity-key.ts";
import type { ApiDispatchContext } from "./routes.ts";
import { dispatchApi } from "./routes.ts";
import { startSession } from "./session.ts";
import type { Socket } from "./socket.ts";
import { authenticateFirstRecord, type FirstRecordDependencies } from "./ws-auth.ts";

export const SECURE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const SECURE_FIRST_RECORD_TIMEOUT_MS = 10_000;
export const MAX_HANDSHAKES_IN_PROGRESS = 64;
const FAILURE_WINDOW_MS = 60 * 60 * 1_000;
const encoder = new TextEncoder();

export interface SecureListenerConfig {
  port: number;
}

export interface SecureListenerDependencies extends FirstRecordDependencies {
  identity: IdentityKeyStore;
  dispatch: ApiDispatchContext;
  runner: ProcessRunner;
  env: Env;
  hc: string;
  session?: string;
  clock?: Clock;
  stdout?: (text: string) => void;
  onDeviceRevocation?: () => void;
}

interface ActiveSecureSession {
  device: DeviceRecordView;
  session: SecureSession;
  closeListeners: Array<() => void>;
  closed: boolean;
  recordsIn: number;
  recordsOut: number;
  bytesIn: number;
  bytesOut: number;
  ip: string;
}

interface TrackedConnection {
  socket: DuplexSocket;
  generation: number;
  closed: boolean;
}

interface SecureConnectionHandler {
  readonly generation: number;
  reserve(): boolean;
  releaseReservation(): void;
  accept(
    socket: DuplexSocket,
    ip: string,
    reserved?: boolean,
    onSplit?: () => void,
    generation?: number,
  ): void;
  rejectBusy(ip: string): void;
  closeRevokedSessions(liveDeviceIds: ReadonlySet<string>): void;
  rotate(): void;
  readonly sessions: number;
  readonly handshakeFailuresLastHour: number;
}

function isoTime(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

function safeIp(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 64) : "unknown";
}

function createSecureConnectionHandler(
  dependencies: SecureListenerDependencies,
): SecureConnectionHandler {
  const clock = dependencies.clock ?? systemClock;
  const output = dependencies.stdout ?? ((text: string) => console.log(text));
  const pendingFailureTimes: number[] = [];
  const active = new Set<ActiveSecureSession>();
  let handshakes = 0;
  let identityGeneration = 0;

  const logFailure = (
    ip: string,
    reason: "protocol" | "timeout" | "busy" | "bad_token" | "bad_code" | "key_mismatch",
  ) => {
    const now = clock.now();
    pendingFailureTimes.push(now);
    trimFailures(now);
    output(
      `Secure handshake failed ${JSON.stringify({ time: isoTime(clock), ip: safeIp(ip), reason })}`,
    );
  };

  function trimFailures(now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS;
    while (pendingFailureTimes.length > 0 && (pendingFailureTimes[0] ?? 0) < cutoff) {
      pendingFailureTimes.shift();
    }
  }

  const closeActive = (entry: ActiveSecureSession, code: number, reason: string) => {
    if (entry.closed) return;
    entry.session.close(code, reason);
  };

  const activate = (
    channel: SecureSession,
    device: DeviceRecordView,
    ip: string,
    firstRecord: Uint8Array,
    reply: AuthReply | PairReply,
  ) => {
    const entry: ActiveSecureSession = {
      device,
      session: channel,
      closeListeners: [],
      closed: false,
      recordsIn: 1,
      recordsOut: 0,
      bytesIn: firstRecord.byteLength,
      bytesOut: 0,
      ip: safeIp(ip),
    };
    active.add(entry);
    output(
      `Secure session opened ${JSON.stringify({
        time: isoTime(clock),
        device: { id: device.id, name: device.name, role: device.role },
        ip: entry.ip,
      })}`,
    );

    const send = (kind: "text" | "binary", bytes: Uint8Array) => {
      if (entry.closed) return;
      entry.recordsOut++;
      entry.bytesOut += bytes.byteLength;
      channel.send(kind, bytes);
    };

    const trackedSession: SecureSession = {
      send,
      onRecord(listener) {
        channel.onRecord(listener);
      },
      close(code, reason) {
        channel.close(code, reason);
      },
      get closed() {
        return channel.closed;
      },
      get handshakeHash() {
        return channel.handshakeHash;
      },
    };
    const channelApi = createChannelApi(
      trackedSession,
      device,
      async (request, resolveCaller) => {
        const { api, appCli, agentStarter } = dependencies.dispatch;
        return dispatchApi(request, resolveCaller, { api, appCli, agentStarter });
      },
      dependencies.onDeviceRevocation,
    );

    let onBinary: ((bytes: Uint8Array) => void) | undefined;
    const socket: Socket = {
      send(bytes) {
        send("binary", bytes);
      },
      close(code, reason) {
        channel.close(code, reason);
      },
      onMessage(listener) {
        onBinary = listener;
      },
      onClose(listener) {
        if (entry.closed) listener();
        else entry.closeListeners.push(listener);
      },
    };

    channel.onRecord((kind, bytes) => {
      if (entry.closed) return;
      entry.recordsIn++;
      entry.bytesIn += bytes.byteLength;
      if (kind === "binary") onBinary?.(bytes);
      else channelApi.receive(bytes);
    });

    channel.closed.then(({ code, reason }) => {
      if (entry.closed) return;
      entry.closed = true;
      active.delete(entry);
      channelApi.close();
      for (const listener of entry.closeListeners) {
        try {
          listener();
        } catch {
          // Closing one child session must not prevent other cleanup.
        }
      }
      output(
        `Secure session closed ${JSON.stringify({
          time: isoTime(clock),
          device: { id: device.id, name: device.name, role: device.role },
          ip: entry.ip,
          code,
          reason,
          recordsIn: entry.recordsIn,
          recordsOut: entry.recordsOut,
          bytesIn: entry.bytesIn,
          bytesOut: entry.bytesOut,
        })}`,
      );
    });

    try {
      send("text", encoder.encode(JSON.stringify(reply)));
      startSession({
        socket,
        runner: dependencies.runner,
        clock,
        env: dependencies.env,
        role: device.role,
        hc: dependencies.hc,
        ...(dependencies.session === undefined ? {} : { session: dependencies.session }),
      });
    } catch {
      closeActive(entry, BRIDGE_WS_CLOSE_CODES.CHILD_EXITED, "could not start hc connect");
    }
  };

  const runHandshake = async (connection: TrackedConnection, ip: string, onSplit?: () => void) => {
    const { socket, generation } = connection;
    let phase: "handshake" | "first-record" | "authenticating" | "authenticated" | "closed" =
      "handshake";
    let authTimer: unknown;
    let timerStarted = false;
    let session: SecureSession | undefined;
    let firstRecord: Uint8Array | undefined;
    const setAuthTimer = () => {
      timerStarted = true;
      authTimer = clock.setTimeout(() => {
        if (phase !== "first-record") return;
        phase = "closed";
        logFailure(ip, "timeout");
        socket.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "authentication required");
      }, SECURE_FIRST_RECORD_TIMEOUT_MS);
    };
    const clearAuthTimer = () => {
      if (!timerStarted) return;
      timerStarted = false;
      clock.clearTimeout(authTimer);
    };

    try {
      const localStatic = dependencies.identity.current();
      const handshake = openResponder(socket, {
        localStatic,
        deadlineMs: SECURE_HANDSHAKE_TIMEOUT_MS,
        clock,
      });
      localStatic.secretKey.fill(0);
      session = await handshake;
    } catch (error) {
      phase = "closed";
      if (generation !== identityGeneration) return;
      if (error instanceof KeyMismatchError) logFailure(ip, "key_mismatch");
      else if (error instanceof HandshakeError && error.message.includes("deadline")) {
        logFailure(ip, "timeout");
      } else logFailure(ip, "protocol");
      return;
    } finally {
      handshakes = Math.max(0, handshakes - 1);
    }

    if (!session) return;
    if (connection.closed || generation !== identityGeneration) {
      session.close(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED, "bridge identity rotated");
      return;
    }
    onSplit?.();
    phase = "first-record";
    setAuthTimer();
    const secureSession = session;
    secureSession.closed.then(({ code }) => {
      if (
        phase !== "closed" &&
        phase !== "authenticated" &&
        code !== 1000 &&
        generation === identityGeneration
      ) {
        logFailure(ip, "protocol");
      }
      phase = "closed";
      clearAuthTimer();
    });
    secureSession.onRecord((kind, bytes) => {
      if (phase === "closed" || phase === "authenticated") return;
      if (phase === "authenticating") {
        phase = "closed";
        logFailure(ip, "protocol");
        secureSession.close(BRIDGE_WS_CLOSE_CODES.RECORD_PROTOCOL, "record protocol error");
        return;
      }
      if (phase !== "first-record" || kind !== "text") {
        phase = "closed";
        clearAuthTimer();
        logFailure(ip, "protocol");
        secureSession.close(BRIDGE_WS_CLOSE_CODES.RECORD_PROTOCOL, "record protocol error");
        return;
      }
      phase = "authenticating";
      clearAuthTimer();
      firstRecord = bytes;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        phase = "closed";
        logFailure(ip, "bad_token");
        secureSession.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "invalid authentication message");
        return;
      }
      void authenticateFirstRecord(text, dependencies)
        .then((result) => {
          if (phase === "closed" || connection.closed || generation !== identityGeneration) return;
          if (result.kind === "reject") {
            phase = "closed";
            logFailure(ip, result.reason);
            secureSession.close(
              result.code,
              result.reason === "bad_code" ? "invalid pair code" : "invalid token",
            );
            return;
          }
          if (!dependencies.devices.list().some((listed) => listed.id === result.device.id)) {
            phase = "closed";
            logFailure(ip, "bad_token");
            secureSession.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "device revoked");
            return;
          }
          if (result.kind === "pair") {
            phase = "authenticated";
            activate(
              secureSession,
              result.device,
              ip,
              firstRecord ?? new Uint8Array(0),
              result.reply,
            );
            return;
          }
          phase = "authenticated";
          const reply: AuthReply = {
            v: BRIDGE_PROTOCOL_VERSION,
            ok: true,
            role: result.device.role,
            machine: dependencies.machine,
            routes: dependencies.routes(),
            bridgeKey: dependencies.bridgeKey(),
          };
          activate(secureSession, result.device, ip, firstRecord ?? new Uint8Array(0), reply);
        })
        .catch(() => {
          if (phase === "closed" || connection.closed || generation !== identityGeneration) return;
          phase = "closed";
          logFailure(ip, "protocol");
          secureSession.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "authentication failed");
        });
    });
  };

  return {
    reserve() {
      if (handshakes >= MAX_HANDSHAKES_IN_PROGRESS) return false;
      handshakes++;
      return true;
    },
    releaseReservation() {
      handshakes = Math.max(0, handshakes - 1);
    },
    accept(socket, ip, reserved = false, onSplit, generation = identityGeneration) {
      if (!reserved && handshakes >= MAX_HANDSHAKES_IN_PROGRESS) {
        socket.close(BRIDGE_WS_CLOSE_CODES.BUSY, "too many handshakes");
        logFailure(ip, "busy");
        return;
      }
      if (!reserved) handshakes++;
      const connection: TrackedConnection = { socket, generation, closed: false };
      socket.onClose(() => {
        connection.closed = true;
      });
      if (generation !== identityGeneration) {
        handshakes = Math.max(0, handshakes - 1);
        socket.close(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED, "bridge identity rotated");
        return;
      }
      void runHandshake(connection, safeIp(ip), onSplit);
    },
    rejectBusy(ip) {
      logFailure(ip, "busy");
    },
    closeRevokedSessions(liveDeviceIds) {
      for (const entry of active) {
        if (!liveDeviceIds.has(entry.device.id)) {
          closeActive(entry, BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "device revoked");
        }
      }
    },
    rotate() {
      identityGeneration++;
    },
    get generation() {
      return identityGeneration;
    },
    get sessions() {
      return active.size;
    },
    get handshakeFailuresLastHour() {
      trimFailures(clock.now());
      return pendingFailureTimes.length;
    },
  };
}

interface SecureSocketData {
  ip: string;
  reserved: boolean;
  busy: boolean;
  phase: "handshake" | "open";
  generation: number;
  closeRequest?: { code: number; reason: string };
  socket?: Bun.ServerWebSocket<SecureSocketData>;
  messages: Array<(bytes: Uint8Array) => void>;
  closes: Array<(code: number, reason: string) => void>;
}

function bunDuplexSocket(ws: Bun.ServerWebSocket<SecureSocketData>): DuplexSocket {
  return {
    send(bytes) {
      ws.send(bytes);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(listener) {
      ws.data.messages.push(listener);
    },
    onClose(listener) {
      ws.data.closes.push(listener);
    },
  };
}

function messageBytes(message: string | Uint8Array): Uint8Array | undefined {
  if (typeof message === "string") return undefined;
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice();
}

/** Starts the loopback-only listener used by cloudflared. */
export async function startSecureListener(
  config: SecureListenerConfig,
  dependencies: SecureListenerDependencies,
): Promise<{
  port: number;
  stop(): void;
  closeRevokedSessions(liveDeviceIds: ReadonlySet<string>): void;
  readonly sessions: number;
  readonly handshakeFailuresLastHour: number;
}> {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error("secure listener port must be an integer from 0 to 65535");
  }

  const handler = createSecureConnectionHandler(dependencies);
  const accepted = new Set<SecureSocketData>();
  const closeAccepted = (code: number, reason: string) => {
    for (const data of accepted) {
      data.closeRequest = { code, reason };
      data.socket?.close(code, reason);
    }
  };
  let server: Bun.Server<SecureSocketData>;
  const stopOnRotate = dependencies.identity.onRotate(() => {
    handler.rotate();
    closeAccepted(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED, "bridge identity rotated");
  });

  try {
    server = Bun.serve<SecureSocketData>({
      hostname: "127.0.0.1",
      port: config.port,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== "/ws") {
          return new Response(null, { status: 404 });
        }
        const ip = safeIp(request.headers.get("Cf-Connecting-Ip") ?? undefined);
        const reserved = handler.reserve();
        if (!reserved) handler.rejectBusy(ip);
        const data: SecureSocketData = {
          ip,
          reserved,
          busy: !reserved,
          phase: "handshake",
          generation: handler.generation,
          messages: [],
          closes: [],
        };
        accepted.add(data);
        if (!bunServer.upgrade(request, { data })) {
          accepted.delete(data);
          if (reserved) handler.releaseReservation();
          return new Response(null, { status: 400 });
        }
        return undefined;
      },
      websocket: {
        open(ws) {
          ws.data.socket = ws;
          if (ws.data.closeRequest) {
            ws.close(ws.data.closeRequest.code, ws.data.closeRequest.reason);
            return;
          }
          if (ws.data.busy) {
            ws.close(BRIDGE_WS_CLOSE_CODES.BUSY, "too many handshakes");
            return;
          }
          ws.data.reserved = false;
          handler.accept(
            bunDuplexSocket(ws),
            ws.data.ip,
            true,
            () => {
              ws.data.phase = "open";
            },
            ws.data.generation,
          );
        },
        message(ws, message) {
          const bytes = messageBytes(message);
          if (!bytes) {
            const code =
              ws.data.phase === "handshake"
                ? BRIDGE_WS_CLOSE_CODES.HANDSHAKE_PROTOCOL
                : BRIDGE_WS_CLOSE_CODES.RECORD_PROTOCOL;
            ws.close(code, "binary frames required");
            return;
          }
          for (const listener of [...ws.data.messages]) listener(bytes);
        },
        close(ws, code, reason) {
          accepted.delete(ws.data);
          if (ws.data.reserved) {
            ws.data.reserved = false;
            handler.releaseReservation();
          }
          for (const listener of [...ws.data.closes]) listener(code, reason);
        },
      },
    });
  } catch (error) {
    stopOnRotate();
    throw error;
  }

  return {
    port: server.port ?? config.port,
    stop() {
      stopOnRotate();
      closeAccepted(1001, "bridge stopping");
      server.stop(true);
    },
    closeRevokedSessions: (liveDeviceIds) => handler.closeRevokedSessions(liveDeviceIds),
    get sessions() {
      return handler.sessions;
    },
    get handshakeFailuresLastHour() {
      return handler.handshakeFailuresLastHour;
    },
  };
}
