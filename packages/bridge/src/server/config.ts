import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { BridgeMachine } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;

export interface BridgeConfig {
  ownerLogin: string;
  host: string;
  port: number;
  publicUrl: string;
  webDir: string;
  hcPath: string;
  herdrAppPath: string;
  session?: string;
  whois: boolean;
  stateDir: string;
  deviceFilePath: string;
  adminSocketPath: string;
  machine: BridgeMachine;
  env: Record<string, string>;
  cwd: string;
}

export interface ConfigDependencies {
  runner: ProcessRunner;
  env: Env;
  cwd: string;
  clock?: Clock;
  machine?: BridgeMachine;
}

export interface BridgeStatePaths {
  stateDir: string;
  deviceFilePath: string;
  adminSocketPath: string;
}

interface ParsedFlags {
  ownerLogin: string;
  port: number;
  publicUrl?: string;
  webDir: string;
  hcPath: string;
  herdrAppPath: string;
  session?: string;
  whois: boolean;
}

function flagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("--port must be an integer from 1 to 65535");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--public-url must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("--public-url must be an HTTPS origin without a path, query, or fragment");
  }
  return url.origin;
}

/** Parses the `serve` options and applies filesystem defaults without starting child processes. */
export function parseServeFlags(args: readonly string[], cwd: string): ParsedFlags {
  let ownerLogin: string | undefined;
  let port = DEFAULT_PORT;
  let publicUrl: string | undefined;
  let webDir = resolve(cwd, "packages/app/dist");
  let hcPath = "hc";
  let herdrAppPath = "herdr-app";
  let session: string | undefined;
  let whois = false;

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    switch (flag) {
      case "--owner":
        ownerLogin = flagValue(args, index, flag).trim();
        index++;
        break;
      case "--port":
        port = parsePort(flagValue(args, index, flag));
        index++;
        break;
      case "--public-url":
        publicUrl = normalizePublicUrl(flagValue(args, index, flag));
        index++;
        break;
      case "--web":
        webDir = resolve(cwd, flagValue(args, index, flag));
        index++;
        break;
      case "--hc":
        hcPath = resolve(cwd, flagValue(args, index, flag));
        index++;
        break;
      case "--herdr-app":
        herdrAppPath = resolve(cwd, flagValue(args, index, flag));
        index++;
        break;
      case "--session":
        session = flagValue(args, index, flag).trim();
        if (session === "") throw new Error("--session must not be empty");
        index++;
        break;
      case "--whois":
        whois = true;
        break;
      default:
        throw new Error(`unknown serve option: ${flag}`);
    }
  }

  if (!ownerLogin) throw new Error("serve requires --owner <login>");
  return {
    ownerLogin,
    port,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    webDir,
    hcPath,
    herdrAppPath,
    ...(session === undefined ? {} : { session }),
    whois,
  };
}

function recordEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function bridgeStatePaths(env: Env): BridgeStatePaths {
  const home = env.HOME || homedir();
  const stateHome = env.XDG_STATE_HOME || join(home, ".local/state");
  const stateDir = join(resolve(stateHome), "herdr-bridge");
  return {
    stateDir,
    deviceFilePath: join(stateDir, "devices.json"),
    adminSocketPath: join(stateDir, "admin.sock"),
  };
}

async function readAll(child: ReturnType<ProcessRunner["spawn"]>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolveEnd) => {
    finish = resolveEnd;
  });
  child.read((bytes) => {
    chunks.push(bytes.slice());
    byteLength += bytes.byteLength;
  }, finish);
  await ended;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads Tailscale's own DNS name and turns it into the public HTTPS origin. */
export async function discoverPublicUrl(
  runner: ProcessRunner,
  options: { env: Record<string, string>; cwd: string; clock?: Clock },
): Promise<string> {
  const child = runner.spawn(["tailscale", "status", "--json"], {
    env: options.env,
    cwd: options.cwd,
  });
  const clock = options.clock ?? systemClock;
  try {
    const outputPromise = readAll(child);
    const [exitCode, output] = await within(
      "tailscale status",
      Promise.all([child.exited, outputPromise]),
      TAILSCALE_STATUS_TIMEOUT_MS,
      clock,
      new AbortController().signal,
    );
    if (exitCode !== 0) throw new Error("tailscale status exited unsuccessfully");
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("Self" in parsed) ||
      typeof parsed.Self !== "object" ||
      parsed.Self === null ||
      !("DNSName" in parsed.Self) ||
      typeof parsed.Self.DNSName !== "string"
    ) {
      throw new Error("tailscale status did not include Self.DNSName");
    }
    const dnsName = parsed.Self.DNSName.replace(/\.+$/u, "");
    if (!dnsName || /[\s/:?#@]/u.test(dnsName)) {
      throw new Error("tailscale status returned an invalid Self.DNSName");
    }
    return normalizePublicUrl(`https://${dnsName}`);
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** Builds the complete server configuration and resolves the default Tailscale URL if needed. */
export async function createBridgeConfig(
  args: readonly string[],
  dependencies: ConfigDependencies,
): Promise<BridgeConfig> {
  const flags = parseServeFlags(args, dependencies.cwd);
  const env = recordEnv(dependencies.env);
  const paths = bridgeStatePaths(dependencies.env);
  const machineName = hostname();
  const publicUrl =
    flags.publicUrl ??
    (await discoverPublicUrl(dependencies.runner, {
      env,
      cwd: dependencies.cwd,
      clock: dependencies.clock,
    }));

  return {
    ownerLogin: flags.ownerLogin,
    host: DEFAULT_HOST,
    port: flags.port,
    publicUrl,
    webDir: flags.webDir,
    hcPath: flags.hcPath,
    herdrAppPath: flags.herdrAppPath,
    ...(flags.session === undefined ? {} : { session: flags.session }),
    whois: flags.whois,
    ...paths,
    machine: dependencies.machine ?? { id: machineName, name: machineName },
    env,
    cwd: dependencies.cwd,
  };
}

/** Refuses a public or wildcard bind before a socket can be opened. */
export function assertLoopbackHost(host: string): void {
  if (host !== DEFAULT_HOST) {
    throw new Error(`bridge host must be ${DEFAULT_HOST}; put Tailscale Serve in front of it`);
  }
}
