import type { DeviceRecordView } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { DeadlineError, systemClock, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import type { DeviceStore } from "./devices.ts";
import type { WhoisLookup } from "./identity.ts";
import { checkIdentity } from "./identity.ts";

const APP_ACTIONS = new Set(["space.new", "tab.new"]);
const APP_ACTION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 32 * 1024;

export interface AppCliContext {
  identity: { ownerLogin: string };
  whois?: WhoisLookup;
  devices: DeviceStore;
  runner: ProcessRunner;
  env: Record<string, string>;
  cwd: string;
  herdrAppPath: string;
  clock?: Clock;
}

interface CapturedProcess {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function failure(status: number, error: string, message?: string): Response {
  return json(message === undefined ? { error } : { error, message }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(headers: Headers): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(headers.get("Authorization") ?? "");
  return match?.[1];
}

function collect(
  read: (onData: (bytes: Uint8Array) => void, onEnd: () => void) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    read(
      (chunk) => {
        chunks.push(chunk.slice());
        length += chunk.byteLength;
      },
      () => {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(new TextDecoder().decode(bytes));
      },
    );
  });
}

async function runHerdrApp(context: AppCliContext, argv: string[]): Promise<CapturedProcess> {
  const child = context.runner.spawn(argv, {
    env: context.env,
    cwd: context.cwd,
    stderr: "pipe",
  });
  const stdout = collect((onData, onEnd) => child.read(onData, onEnd));
  const stderr = child.readStderr
    ? collect((onData, onEnd) => child.readStderr?.(onData, onEnd))
    : Promise.resolve("");
  try {
    const [exitCode, output, errors] = await within(
      "herdr-app",
      Promise.all([child.exited, stdout, stderr]),
      APP_ACTION_TIMEOUT_MS,
      context.clock ?? systemClock,
      new AbortController().signal,
    );
    return { exitCode, stdout: output, stderr: errors };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function authenticatedCaller(
  request: Request,
  context: AppCliContext,
): Promise<DeviceRecordView | Response> {
  if (!(await checkIdentity(request.headers, context.identity, context.whois))) {
    return failure(403, "forbidden");
  }
  const token = bearerToken(request.headers);
  const caller = token ? await context.devices.findByToken(token) : undefined;
  if (!caller) return failure(401, "unauthorized");
  if (caller.role !== "control") return failure(403, "forbidden");
  return caller;
}

async function requestBody(request: Request): Promise<unknown | Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return failure(413, "body_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failure(400, "bad_request");
  }
}

function validateArgs(value: unknown): string[] | undefined {
  if (!isObject(value)) return undefined;
  const argv: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/u.test(key) || typeof item !== "string" || item.includes("\0")) {
      return undefined;
    }
    if (new TextEncoder().encode(item).byteLength > MAX_ARGUMENT_BYTES) return undefined;
    argv.push(`--${key}`, item);
  }
  return argv;
}

function cliFailure(error: unknown): Response {
  if (error instanceof DeadlineError) return failure(504, "herdr_app_timeout", error.message);
  return failure(409, "herdr_app_failed", error instanceof Error ? error.message : String(error));
}

/** Handles the two whitelisted herdr-app actions without invoking a shell. */
export async function handleAppCli(
  request: Request,
  context: AppCliContext,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/app/ls" && path !== "/api/app/do") return undefined;

  const caller = await authenticatedCaller(request, context);
  if (caller instanceof Response) return caller;

  if (path === "/api/app/ls") {
    if (request.method !== "GET") return failure(405, "method_not_allowed", "Use GET.");
    try {
      const result = await runHerdrApp(context, [context.herdrAppPath, "ls"]);
      if (result.exitCode !== 0) return failure(409, "herdr_app_failed", result.stderr);
      return new Response(result.stdout, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      return cliFailure(error);
    }
  }

  if (request.method !== "POST") return failure(405, "method_not_allowed", "Use POST.");
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (!isObject(body) || typeof body.action !== "string" || !APP_ACTIONS.has(body.action)) {
    return failure(400, "bad_request");
  }
  const args = validateArgs(body.args ?? {});
  if (!args) return failure(400, "bad_request");

  try {
    const result = await runHerdrApp(context, [context.herdrAppPath, "do", body.action, ...args]);
    if (result.exitCode !== 0) return failure(409, "herdr_app_failed", result.stderr);
    return new Response(result.stdout, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return cliFailure(error);
  }
}
