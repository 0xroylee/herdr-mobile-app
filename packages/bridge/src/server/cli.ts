import { toString as qrToString } from "qrcode";
import type { Clock } from "../prototype/deadline.ts";
import { bunRunner, type ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";
import { bridgeStatePaths, createBridgeConfig } from "./config.ts";
import { serveBridge } from "./serve.ts";

const HELP = `herdr-bridge — private Tailscale bridge for herdr-core

Usage:
  herdr-bridge serve --owner <login> [--port 8787] [--public-url https://host]
    [--web <dir>] [--hc <path>] [--herdr-app <path>] [--session <name>] [--whois]
  herdr-bridge pair [--watch] [--name <device>]
  herdr-bridge devices [revoke <id>]
  herdr-bridge status
  herdr-bridge --help
`;

export interface CliDependencies {
  env?: Env;
  cwd?: string;
  runner?: ProcessRunner;
  clock?: Clock;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  adminFetch?: AdminFetch;
}

/** Hides local admin-socket HTTP requests; `defaultAdminFetch` is the production adapter and injected `adminFetch` functions are the fake adapters. */
export type AdminFetch = (
  socketPath: string,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

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

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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
  const status = await responseJson<{ publicUrl: string }>(
    await adminFetch(socketPath, "/status"),
    "status",
  );
  const publicUrl = new URL(status.publicUrl).origin;
  const request = await adminFetch(socketPath, "/pair-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role: parsed.role,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
    }),
  });
  const issued = await responseJson<{ code: string; expiresAt: number }>(request, "pair code");
  const fragment = encodeBase64Url(JSON.stringify({ u: publicUrl, c: issued.code }));
  const link = `${publicUrl}/#pair=${fragment}`;
  stdout(`Pair link: ${link}`);
  stdout(await qrToString(link, { type: "terminal", small: true }));
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
    throw new Error(`unknown command: ${command}\n${HELP}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
