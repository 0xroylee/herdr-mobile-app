import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  type AuthMessage,
  type AuthReply,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WS_CLOSE_CODES,
  type BridgeMachine,
  type DeviceRecordView,
} from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";
import { bunRunner, type ProcessRunner } from "../prototype/process.ts";
import { handleAdminApi } from "./admin-routes.ts";
import { handleAgentsRoutes } from "./agents-routes.ts";
import type { AppCliContext } from "./app-cli.ts";
import { handleAppCli } from "./app-cli.ts";
import type { BridgeConfig } from "./config.ts";
import { assertLoopbackHost } from "./config.ts";
import { DeviceStore, nodeStoreFs } from "./devices.ts";
import {
  checkIdentity,
  createWhoisLookup,
  type IdentityConfig,
  type WhoisLookup,
} from "./identity.ts";
import { PairingCodes } from "./pairing.ts";
import { type ApiContext, handleApi } from "./routes.ts";
import { startSession } from "./session.ts";
import type { Socket } from "./socket.ts";
import { AgentStarter } from "./start-agent.ts";
import { type StaticFs, serveStatic } from "./static.ts";

export const WS_AUTH_TIMEOUT_MS = 10_000;

interface ConnectionData {
  authenticated: boolean;
  authenticating: boolean;
  failed: boolean;
  closed: boolean;
  counted: boolean;
  deviceId?: string;
  authTimer?: unknown;
  onMessage?: (bytes: Uint8Array) => void;
  onClose?: () => void;
}

/** Hides Bun's upgrade operation; `Bun.Server` is the production adapter and `fakeWebSocketUpgradeTarget` is the test adapter. */
export interface WebSocketUpgradeTarget {
  upgrade(request: Request, options: { data: ConnectionData }): boolean;
}

export interface BridgeHttpContext {
  api: ApiContext;
  appCli: AppCliContext;
  agentStarter?: AgentStarter;
  identity: IdentityConfig;
  whois?: WhoisLookup;
  webDir: string;
  staticFs?: StaticFs;
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Creates the pure HTTP dispatch used by Bun and handler-level tests. */
export function createBridgeFetchHandler(context: BridgeHttpContext) {
  return async (
    request: Request,
    server?: WebSocketUpgradeTarget,
  ): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (path === "/ws") {
      if (!(await checkIdentity(request.headers, context.identity, context.whois))) {
        return errorResponse(403, "forbidden");
      }
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
      if (
        !server?.upgrade(request, {
          data: {
            authenticated: false,
            authenticating: false,
            failed: false,
            closed: false,
            counted: false,
          },
        })
      ) {
        return errorResponse(400, "upgrade_failed");
      }
      return undefined;
    }

    if (path === "/api" || path.startsWith("/api/")) {
      if (context.agentStarter) {
        const agentsResponse = await handleAgentsRoutes(
          request,
          context.appCli,
          context.agentStarter,
        );
        if (agentsResponse) return agentsResponse;
      }
      const appResponse = await handleAppCli(request, context.appCli);
      if (appResponse) return appResponse;
      return (await handleApi(request, context.api)) ?? errorResponse(404, "not_found");
    }

    if (!(await checkIdentity(request.headers, context.identity, context.whois))) {
      return errorResponse(403, "forbidden");
    }
    return serveStatic(request, context.webDir, context.staticFs);
  };
}

export interface ServeDependencies {
  runner?: ProcessRunner;
  clock?: Clock;
  staticFs?: StaticFs;
  stdout?: (text: string) => void;
}

export interface RunningBridge {
  readonly host: string;
  readonly port: number;
  readonly adminSocketPath: string;
  readonly devices: DeviceStore;
  stop(): Promise<void>;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`bridge state path is not a directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function assertSocketPathAvailable(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isSocket()) {
    throw new Error(
      `admin socket already exists: ${path}; confirm the bridge is stopped before removing it`,
    );
  }
  throw new Error(`admin socket path already exists and is not a socket: ${path}`);
}

function isAuthMessage(value: unknown): value is AuthMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "v" in value &&
    value.v === BRIDGE_PROTOCOL_VERSION &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 128
  );
}

function clearAuthenticationTimer(data: ConnectionData, clock: Clock): void {
  if (data.authTimer !== undefined) clock.clearTimeout(data.authTimer);
  data.authTimer = undefined;
}

function rejectAuthentication(
  ws: Bun.ServerWebSocket<ConnectionData>,
  clock: Clock,
  reason: string,
): void {
  const data = ws.data;
  if (data.closed || data.failed) return;
  data.failed = true;
  clearAuthenticationTimer(data, clock);
  ws.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, reason);
}

function asBytes(message: string | Uint8Array): Uint8Array | undefined {
  if (typeof message === "string") return undefined;
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice();
}

/** Starts the loopback HTTP/WebSocket server and the private local admin socket. */
export async function serveBridge(
  config: BridgeConfig,
  dependencies: ServeDependencies = {},
): Promise<RunningBridge> {
  assertLoopbackHost(config.host);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("bridge port must be an integer from 1 to 65535");
  }

  const clock = dependencies.clock ?? systemClock;
  const runner = dependencies.runner ?? bunRunner;
  const stateDir = resolve(config.stateDir);
  const adminSocketPath = resolve(config.adminSocketPath);
  const deviceFilePath = resolve(config.deviceFilePath);
  if (dirname(adminSocketPath) !== stateDir || basename(adminSocketPath) !== "admin.sock") {
    throw new Error("admin socket must be admin.sock inside the private bridge state directory");
  }
  if (dirname(deviceFilePath) !== stateDir || basename(deviceFilePath) !== "devices.json") {
    throw new Error("device file must be devices.json inside the private bridge state directory");
  }
  await ensurePrivateDirectory(stateDir);
  await assertSocketPathAvailable(adminSocketPath);

  const devices = await DeviceStore.open(nodeStoreFs, deviceFilePath, clock);

  const pairing = new PairingCodes(clock);
  const identity: IdentityConfig = { ownerLogin: config.ownerLogin };
  const whois = config.whois
    ? createWhoisLookup(runner, { env: config.env, cwd: config.cwd, clock })
    : undefined;
  const machine: BridgeMachine = config.machine;
  const appCli: AppCliContext = {
    identity,
    ...(whois === undefined ? {} : { whois }),
    devices,
    runner,
    env: config.env,
    cwd: config.cwd,
    herdrAppPath: config.herdrAppPath,
    clock,
  };
  const agentStarter = new AgentStarter({
    runner,
    programs: config.programs,
    roots: config.roots,
    home: config.home,
    herdrAppPath: config.herdrAppPath,
    hcPath: config.hcPath,
    ...(config.session === undefined ? {} : { session: config.session }),
    env: config.env,
    cwd: config.cwd,
    clock,
    output: dependencies.stdout ?? ((text) => console.log(text)),
  });
  const api: ApiContext = {
    identity,
    ...(whois === undefined ? {} : { whois }),
    devices,
    pairing,
    machine,
  };

  let sessions = 0;
  let currentPort = config.port;
  const activeSockets = new Set<Bun.ServerWebSocket<ConnectionData>>();
  const adminApi = {
    devices,
    pairing,
    status: () => ({
      machine,
      publicUrl: config.publicUrl,
      listen: `${config.host}:${currentPort}`,
      sessions,
    }),
  };

  let adminServer: Bun.Server<undefined> | undefined;
  let webServer: Bun.Server<ConnectionData> | undefined;

  const endSocket = (ws: Bun.ServerWebSocket<ConnectionData>) => {
    const data = ws.data;
    if (data.closed) return;
    data.closed = true;
    clearAuthenticationTimer(data, clock);
    if (data.counted) {
      data.counted = false;
      sessions = Math.max(0, sessions - 1);
      activeSockets.delete(ws);
    }
    data.onClose?.();
  };

  const closeRevokedSessions = () => {
    const liveDeviceIds = new Set(devices.list().map((device) => device.id));
    for (const socket of activeSockets) {
      const data = socket.data;
      if (data.deviceId !== undefined && liveDeviceIds.has(data.deviceId)) continue;
      endSocket(socket);
      socket.close(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN, "device revoked");
    }
  };

  try {
    adminServer = Bun.serve({
      unix: adminSocketPath,
      fetch: async (request) => {
        if (
          request.method === "DELETE" &&
          /^\/devices\/[^/]+$/u.test(new URL(request.url).pathname)
        ) {
          try {
            return (await handleAdminApi(request, adminApi)) ?? errorResponse(404, "not_found");
          } finally {
            closeRevokedSessions();
          }
        }
        return (await handleAdminApi(request, adminApi)) ?? errorResponse(404, "not_found");
      },
    });
    await chmod(adminSocketPath, 0o600);

    const fetchHandler = createBridgeFetchHandler({
      api,
      appCli,
      agentStarter,
      identity,
      ...(whois === undefined ? {} : { whois }),
      webDir: config.webDir,
      ...(dependencies.staticFs === undefined ? {} : { staticFs: dependencies.staticFs }),
    });

    webServer = Bun.serve<ConnectionData>({
      hostname: config.host,
      port: config.port,
      fetch: async (request, server) => {
        if (
          request.method === "DELETE" &&
          /^\/api\/devices\/[^/]+$/u.test(new URL(request.url).pathname)
        ) {
          try {
            return await fetchHandler(request, server);
          } finally {
            closeRevokedSessions();
          }
        }
        return fetchHandler(request, server);
      },
      websocket: {
        open(ws) {
          ws.data.authTimer = clock.setTimeout(() => {
            if (!ws.data.authenticated) {
              rejectAuthentication(ws, clock, "authentication required");
            }
          }, WS_AUTH_TIMEOUT_MS);
        },
        message(ws, message) {
          const data = ws.data;
          if (data.closed || data.failed) return;
          if (!data.authenticated) {
            if (data.authenticating || typeof message !== "string" || message.length > 1_024) {
              data.authenticating = true;
              rejectAuthentication(ws, clock, "invalid authentication message");
              return;
            }
            data.authenticating = true;
            void (async () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(message) as unknown;
              } catch {
                rejectAuthentication(ws, clock, "invalid authentication message");
                return;
              }
              if (!isAuthMessage(parsed)) {
                rejectAuthentication(ws, clock, "invalid authentication message");
                return;
              }

              let device: DeviceRecordView | undefined;
              try {
                device = await devices.findByToken(parsed.token);
              } catch {
                rejectAuthentication(ws, clock, "invalid token");
                return;
              }
              if (
                !device ||
                data.closed ||
                data.failed ||
                !devices.list().some((listed) => listed.id === device.id)
              ) {
                rejectAuthentication(ws, clock, "invalid token");
                return;
              }

              clearAuthenticationTimer(data, clock);
              data.deviceId = device.id;
              data.authenticated = true;
              data.counted = true;
              sessions++;
              activeSockets.add(ws);
              const reply: AuthReply = {
                v: BRIDGE_PROTOCOL_VERSION,
                ok: true,
                role: device.role,
                machine,
              };
              try {
                ws.send(JSON.stringify(reply));
              } catch {
                rejectAuthentication(ws, clock, "authentication failed");
                return;
              }

              const socket: Socket = {
                send(bytes) {
                  if (!data.closed) ws.send(bytes);
                },
                close(code, reason) {
                  ws.close(code, reason);
                },
                onMessage(listener) {
                  data.onMessage = listener;
                },
                onClose(listener) {
                  data.onClose = listener;
                },
              };
              try {
                startSession({
                  socket,
                  runner,
                  clock,
                  env: config.env,
                  role: device.role,
                  hc: config.hcPath,
                  ...(config.session === undefined ? {} : { session: config.session }),
                });
              } catch {
                ws.close(BRIDGE_WS_CLOSE_CODES.CHILD_EXITED, "could not start hc connect");
              }
            })();
            return;
          }

          const bytes = asBytes(message);
          if (!bytes) {
            ws.close(1003, "binary messages required");
            return;
          }
          data.onMessage?.(bytes);
        },
        close(ws) {
          const data = ws.data;
          if (data.closed) return;
          endSocket(ws);
        },
      },
    });
    currentPort = webServer.port ?? config.port;
  } catch (error) {
    webServer?.stop(true);
    adminServer?.stop(true);
    await unlink(adminSocketPath).catch(() => {});
    throw error;
  }

  return {
    host: config.host,
    port: currentPort,
    adminSocketPath,
    devices,
    async stop() {
      for (const socket of activeSockets) socket.close(1001, "bridge stopping");
      webServer?.stop(true);
      adminServer?.stop(true);
      await unlink(adminSocketPath).catch(() => {});
    },
  };
}
