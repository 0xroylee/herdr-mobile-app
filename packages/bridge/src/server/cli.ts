import { encodePairOffer, normalizeOrigin } from "@herdr-mobile/protocol";
import { toString as qrToString } from "qrcode";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock, within } from "../prototype/deadline.ts";
import { bunRunner, type ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";
import { bridgeStatePaths, createBridgeConfig } from "./config.ts";
import { serveBridge } from "./serve.ts";

const HELP = `herdr-bridge — private Tailscale bridge for herdr-core

Usage:
  herdr-bridge serve --owner <login> [--port 8787] [--public-url https://host]
    [--secure-port <port>] [--secure-url <origin>]
    [--web <dir>] [--hc <path>] [--herdr-app <path>] [--session <name>] [--whois]
    [--run-program <name>]... [--run-root <dir>]...
  herdr-bridge pair [--watch] [--name <device>]
  herdr-bridge devices [revoke <id>]
  herdr-bridge status
  herdr-bridge secure url <origin>
  herdr-bridge secure url --from-cloudflared [host:port]
  herdr-bridge secure url --clear
  herdr-bridge identity [rotate]
  herdr-bridge --help
`;

const CLOUDFLARED_METRICS_TIMEOUT_MS = 3_000;
const DEFAULT_CLOUDFLARED_METRICS_ADDRESSES = [20241, 20242, 20243, 20244, 20245].map(
  (port) => `127.0.0.1:${port}`,
);

export interface CliDependencies {
  env?: Env;
  cwd?: string;
  runner?: ProcessRunner;
  clock?: Clock;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  adminFetch?: AdminFetch;
  fetch?: MetricsFetch;
}

/** Hides local admin-socket HTTP requests; `defaultAdminFetch` is the production adapter and injected `adminFetch` functions are the fake adapters. */
export type AdminFetch = (
  socketPath: string,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type MetricsFetch = (input: string, init?: RequestInit) => Promise<Response>;

function envFromProcess(): Env {
  return process.env;
}

function defaultAdminFetch(
  socketPath: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://localhost${path}`, { ...init, unix: socketPath });
}

async function responseJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${label} failed (${response.status}): ${message}`);
  }
  return (await response.json()) as T;
}

function parsePairArgs(args: readonly string[]): { role: "watch" | "control"; name?: string } {
  let role: "watch" | "control" = "control";
  let name: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--watch") {
      role = "watch";
    } else if (arg === "--name") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--name requires a device name");
      name = value;
      index++;
    } else {
      throw new Error(`unknown pair option: ${arg}`);
    }
  }
  return { role, ...(name === undefined ? {} : { name }) };
}

async function pair(
  socketPath: string,
  args: readonly string[],
  adminFetch: AdminFetch,
  stdout: (text: string) => void,
): Promise<void> {
  const parsed = parsePairArgs(args);
  const status = await responseJson<{
    publicUrl: string;
    machine: { name: string };
    bridgeKey: string;
    secure?: { port?: number; url?: string };
    routes?: { direct?: string; secure?: string };
  }>(await adminFetch(socketPath, "/status"), "status");
  const direct = status.routes?.direct ?? status.publicUrl;
  if (typeof status.bridgeKey !== "string")
    throw new Error("status did not include the bridge public key");
  const request = await adminFetch(socketPath, "/pair-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role: parsed.role,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
    }),
  });
  const issued = await responseJson<{ code: string; expiresAt: number }>(request, "pair code");
  const link = encodePairOffer({
    ...(direct === undefined ? {} : { direct }),
    ...(status.secure?.url === undefined ? {} : { secure: status.secure.url }),
    bridgeKey: status.bridgeKey,
    code: issued.code,
    name: status.machine.name,
  });
  if (status.secure?.port !== undefined && status.secure.url === undefined) {
    stdout(
      `Secure listener port ${status.secure.port} is configured, but no secure URL is set. Set one with herdr-bridge secure url.`,
    );
  }
  stdout(`Pair link: ${link}`);
  stdout(await qrToString(link, { type: "terminal", small: true }));
}

async function readCloudflaredUrl(
  fetcher: MetricsFetch,
  address: string | undefined,
  clock: Clock,
): Promise<string> {
  const addresses =
    address === undefined
      ? DEFAULT_CLOUDFLARED_METRICS_ADDRESSES
      : [normalizeMetricsAddress(address)];
  const failures: string[] = [];
  for (const candidate of addresses) {
    const controller = new AbortController();
    const metricsUrl = `http://${candidate}/quicktunnel`;
    try {
      const result = await within(
        "cloudflared metrics",
        (async () => {
          const response = await fetcher(metricsUrl, { signal: controller.signal });
          if (!response.ok) return { kind: "http", status: response.status } as const;
          try {
            return { kind: "body", body: await response.json() } as const;
          } catch {
            return { kind: "invalid-json" } as const;
          }
        })(),
        CLOUDFLARED_METRICS_TIMEOUT_MS,
        clock,
        new AbortController().signal,
      );
      if (result.kind === "http") {
        failures.push(`${candidate}: HTTP ${result.status}`);
        continue;
      }
      if (result.kind === "invalid-json") {
        failures.push(`${candidate}: invalid JSON`);
        continue;
      }
      const body = result.body;
      if (!isObject(body) || typeof body.hostname !== "string") {
        failures.push(`${candidate}: response did not include hostname`);
        continue;
      }
      try {
        return normalizeCloudflaredHostname(body.hostname);
      } catch {
        failures.push(`${candidate}: invalid hostname`);
      }
    } catch (error) {
      controller.abort(error);
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not read cloudflared Quick Tunnel metrics (${failures.join("; ")})`);
}

function normalizeMetricsAddress(address: string): string {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:/?#@]+):(\d{1,5})$/u.exec(address);
  if (!match) throw new Error("cloudflared metrics address must be host:port");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("cloudflared metrics address must be host:port");
  }
  let url: URL;
  try {
    url = new URL(`http://${address}`);
  } catch {
    throw new Error("cloudflared metrics address must be host:port");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("cloudflared metrics address must be host:port");
  }
  return `${url.hostname}:${port}`;
}

function normalizeCloudflaredHostname(hostname: string): string {
  if (!/^[A-Za-z0-9.-]+$/u.test(hostname)) throw new Error("invalid hostname");
  const origin = normalizeOrigin(`https://${hostname}`, { allowPlainHttp: "any" });
  const url = new URL(origin);
  if (url.host !== url.hostname || url.hostname.endsWith(".")) throw new Error("invalid hostname");
  return origin;
}

async function secureUrl(
  socketPath: string,
  args: readonly string[],
  adminFetch: AdminFetch,
  fetcher: MetricsFetch,
  clock: Clock,
  stdout: (text: string) => void,
): Promise<void> {
  if (args[0] !== "url")
    throw new Error(
      "usage: herdr-bridge secure url <origin> | --from-cloudflared [host:port] | --clear",
    );
  const value = args[1];
  if (value === "--clear" && args.length === 2) {
    const response = await adminFetch(socketPath, "/secure-url", { method: "DELETE" });
    if (!response.ok) throw new Error(`secure URL clear failed (${response.status})`);
    stdout("Secure URL cleared.");
    return;
  }

  let url: string;
  if (value === "--from-cloudflared" && (args.length === 2 || args.length === 3)) {
    url = await readCloudflaredUrl(fetcher, args[2], clock);
  } else if (value !== undefined && !value.startsWith("--") && args.length === 2) {
    url = normalizeOrigin(value, { allowPlainHttp: "loopback-and-private" });
  } else {
    throw new Error(
      "usage: herdr-bridge secure url <origin> | --from-cloudflared [host:port] | --clear",
    );
  }

  await responseJson<{ url: string }>(
    await adminFetch(socketPath, "/secure-url", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
    "secure URL",
  );
  stdout(`Secure URL set to ${url}`);
}

async function identity(
  socketPath: string,
  args: readonly string[],
  adminFetch: AdminFetch,
  stdout: (text: string) => void,
): Promise<void> {
  if (args.length === 0) {
    const status = await responseJson<{ bridgeKey: string }>(
      await adminFetch(socketPath, "/status"),
      "status",
    );
    if (typeof status.bridgeKey !== "string")
      throw new Error("status did not include the bridge public key");
    stdout(status.bridgeKey);
    return;
  }
  if (args.length === 1 && args[0] === "rotate") {
    const result = await responseJson<{ bridgeKey: string }>(
      await adminFetch(socketPath, "/identity/rotate", { method: "POST" }),
      "identity rotation",
    );
    stdout(
      `Bridge identity rotated. Secure-only devices must pair again. Public key: ${result.bridgeKey}`,
    );
    return;
  }
  throw new Error("usage: herdr-bridge identity [rotate]");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function devices(
  socketPath: string,
  args: readonly string[],
  adminFetch: AdminFetch,
  stdout: (text: string) => void,
): Promise<void> {
  const revoke =
    args.length === 0
      ? undefined
      : args[0] === "revoke"
        ? args[1]
        : args[0] === "--revoke"
          ? args[1]
          : undefined;
  if (args.length > 0 && (revoke === undefined || args.length !== 2)) {
    throw new Error("usage: herdr-bridge devices [revoke <id>]");
  }
  if (revoke !== undefined) {
    const response = await adminFetch(socketPath, `/devices/${encodeURIComponent(revoke)}`, {
      method: "DELETE",
    });
    if (response.status === 404) throw new Error(`device not found: ${revoke}`);
    if (!response.ok) throw new Error(`device revoke failed (${response.status})`);
    stdout(`Revoked device ${revoke}`);
    return;
  }
  const result = await responseJson<unknown[]>(await adminFetch(socketPath, "/devices"), "devices");
  stdout(JSON.stringify(result, null, 2));
}

/** Runs one CLI command. Dependencies make command formatting and admin requests testable. */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => console.log(text));
  const stderr = dependencies.stderr ?? ((text: string) => console.error(text));
  const env = dependencies.env ?? envFromProcess();
  const cwd = dependencies.cwd ?? process.cwd();
  const runner = dependencies.runner ?? bunRunner;
  const adminFetch: AdminFetch = dependencies.adminFetch ?? defaultAdminFetch;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const clock = dependencies.clock ?? systemClock;
  const command = argv[0];
  const args = argv.slice(1);

  if (!command || command === "--help" || command === "-h" || args.includes("--help")) {
    stdout(HELP);
    return 0;
  }

  try {
    if (command === "serve") {
      const config = await createBridgeConfig(args, {
        runner,
        env,
        cwd,
        ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      });
      const bridge = await serveBridge(config, {
        runner,
        ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      });
      stdout(`Bridge listening on ${bridge.host}:${bridge.port}`);
      stdout(`Admin socket: ${bridge.adminSocketPath}`);
      const stop = () => void bridge.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return 0;
    }

    const state = bridgeStatePaths(env);
    if (command === "pair") {
      await pair(state.adminSocketPath, args, adminFetch, stdout);
      return 0;
    }
    if (command === "devices") {
      await devices(state.adminSocketPath, args, adminFetch, stdout);
      return 0;
    }
    if (command === "status" && args.length === 0) {
      const result = await responseJson<unknown>(
        await adminFetch(state.adminSocketPath, "/status"),
        "status",
      );
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    if (command === "secure") {
      await secureUrl(state.adminSocketPath, args, adminFetch, fetcher, clock, stdout);
      return 0;
    }
    if (command === "identity") {
      await identity(state.adminSocketPath, args, adminFetch, stdout);
      return 0;
    }
    throw new Error(`unknown command: ${command}\n${HELP}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
