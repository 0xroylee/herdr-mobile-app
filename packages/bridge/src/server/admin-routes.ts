import type { BridgeMachine, Role } from "@herdr-mobile/protocol";
import { normalizeOrigin } from "@herdr-mobile/protocol";
import type { AdvertisedRoutes } from "./advertised-routes.ts";
import type { DeviceStore } from "./devices.ts";
import { encodePublicKey, type IdentityKeyStore } from "./identity-key.ts";
import type { PairingCodes } from "./pairing.ts";

/** What the running server reports on the admin socket. U4 provides it. */
export interface AdminStatus {
  machine: BridgeMachine;
  /** The URL phones use, for example https://mac.tailnet.ts.net */
  publicUrl: string;
  /** Where the TCP server listens, for example 127.0.0.1:8787 */
  listen: string;
  /** Phone sessions open now. */
  sessions: number;
  bridgeKey: string;
  secure: { port?: number; url?: string };
}

export type AdminBaseStatus = Omit<AdminStatus, "bridgeKey" | "secure">;

export interface AdminApiContext {
  devices: DeviceStore;
  pairing: PairingCodes;
  routes: AdvertisedRoutes;
  identity: IdentityKeyStore;
  securePort?: number;
  status: () => AdminBaseStatus;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function failure(status: number, error: string): Response {
  return json({ error }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
  return value === "watch" || value === "control";
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Allow: allow,
    },
  });
}

/** Handles local admin-socket HTTP routes; socket permissions are enforced by the caller. */
export async function handleAdminApi(
  request: Request,
  ctx: AdminApiContext,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;

  if (path === "/pair-code") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure(400, "bad_request");
    }
    if (
      !isObject(body) ||
      !isRole(body.role) ||
      (body.name !== undefined && typeof body.name !== "string")
    ) {
      return failure(400, "bad_request");
    }
    const name = typeof body.name === "string" ? body.name : undefined;
    return json(ctx.pairing.issue(body.role, name), 201);
  }

  if (path === "/devices") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(ctx.devices.list());
  }

  const deviceMatch = /^\/devices\/([^/]+)$/u.exec(path);
  if (deviceMatch) {
    if (request.method !== "DELETE") return methodNotAllowed("DELETE");
    let id: string;
    try {
      id = decodeURIComponent(deviceMatch[1] ?? "");
    } catch {
      return failure(400, "bad_request");
    }
    if (!(await ctx.devices.revoke(id))) return failure(404, "not_found");
    return new Response(null, { status: 204 });
  }

  if (path === "/status") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const routes = ctx.routes.snapshot();
    return json({
      ...ctx.status(),
      bridgeKey: encodePublicKey(ctx.identity.current().publicKey),
      secure: {
        ...(ctx.securePort === undefined ? {} : { port: ctx.securePort }),
        ...(routes.secure === undefined ? {} : { url: routes.secure }),
      },
      devices: ctx.devices.list().length,
    });
  }

  if (path === "/secure-url") {
    if (request.method === "PUT") {
      if (ctx.securePort === undefined) return failure(409, "secure_port_disabled");
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure(400, "bad_request");
      }
      if (!isObject(body) || typeof body.url !== "string") return failure(400, "bad_request");
      let url: string;
      try {
        url = normalizeOrigin(body.url, { allowPlainHttp: "loopback-and-private" });
      } catch {
        return failure(400, "bad_request");
      }
      ctx.routes.setSecure(url);
      return json({ url });
    }
    if (request.method === "DELETE") {
      ctx.routes.setSecure(undefined);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed("PUT, DELETE");
  }

  if (path === "/identity/rotate") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const keyPair = await ctx.identity.rotate();
    return json({ bridgeKey: encodePublicKey(keyPair.publicKey) });
  }

  return undefined;
}
