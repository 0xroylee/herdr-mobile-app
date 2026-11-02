import type {
  BridgeMachine,
  DeviceRecordView,
  HttpErrorBody,
  PairReply,
  PairRequest,
} from "@herdr-mobile/protocol";
import type { DeviceStore } from "./devices.ts";
import type { IdentityConfig, WhoisLookup } from "./identity.ts";
import { checkIdentity } from "./identity.ts";
import type { PairingCodes } from "./pairing.ts";
import { createToken } from "./tokens.ts";

export interface ApiContext {
  identity: IdentityConfig;
  whois?: WhoisLookup;
  devices: DeviceStore;
  pairing: PairingCodes;
  machine: BridgeMachine;
}

function json<T>(value: T, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function failure(status: number, error: string, message?: string): Response {
  const body: HttpErrorBody = message === undefined ? { error } : { error, message };
  return json(body, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPairRequest(value: unknown): value is PairRequest {
  return (
    isObject(value) &&
    typeof value.code === "string" &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function bearerToken(headers: Headers): string | undefined {
  const authorization = headers.get("Authorization");
  if (!authorization) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  return match?.[1];
}

function methodNotAllowed(allow: string): Response {
  return failure(405, "method_not_allowed", `Use ${allow}.`);
}

/** Handles the bridge HTTP API without opening a server or reading an unauthenticated body. */
export async function handleApi(request: Request, ctx: ApiContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/api" && !path.startsWith("/api/")) return undefined;

  if (!(await checkIdentity(request.headers, ctx.identity, ctx.whois))) {
    return failure(403, "forbidden");
  }

  const pairingRoute = path === "/api/pair";
  let caller: DeviceRecordView | undefined;
  if (!pairingRoute) {
    const token = bearerToken(request.headers);
    caller = token ? await ctx.devices.findByToken(token) : undefined;
    if (!caller) return failure(401, "unauthorized");
  }

  if (path === "/api/pair") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure(400, "bad_request");
    }
    if (!isPairRequest(body)) return failure(400, "bad_request");

    const grant = ctx.pairing.redeem(body.code);
    if (!grant) return failure(400, "bad_code");
    const token = createToken();
    const name = body.name?.trim() || grant.name;
    const device = await ctx.devices.add({
      token,
      role: grant.role,
      ...(name === undefined ? {} : { name }),
    });
    const reply: PairReply = {
      deviceId: device.id,
      token,
      role: grant.role,
      machine: ctx.machine,
    };
    return json(reply, 201);
  }

  if (path === "/api/health") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ ok: true, machine: ctx.machine });
  }

  if (path === "/api/devices") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(ctx.devices.list());
  }

  const deviceMatch = /^\/api\/devices\/([^/]+)$/u.exec(path);
  if (deviceMatch && caller) {
    if (request.method !== "DELETE") return methodNotAllowed("DELETE");
    let id: string;
    try {
      id = decodeURIComponent(deviceMatch[1] ?? "");
    } catch {
      return failure(400, "bad_request");
    }
    if (id !== "self" && caller.role !== "control") return failure(403, "forbidden");
    const targetId = id === "self" ? caller.id : id;
    if (!(await ctx.devices.revoke(targetId))) return failure(404, "not_found");
    return new Response(null, { status: 204 });
  }

  return failure(404, "not_found");
}
