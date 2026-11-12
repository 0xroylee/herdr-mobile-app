import { describe, expect, test } from "bun:test";
import type { PairReply } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
import { PairingCodes } from "./pairing.ts";
import type { ApiContext } from "./routes.ts";
import { handleApi } from "./routes.ts";

class MapFs implements StoreFs {
  readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async mkdir(): Promise<void> {}
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("missing temporary file");
    this.files.delete(from);
    this.files.set(to, value);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeClock implements Clock {
  time = 1_000_000;
  now(): number {
    return this.time;
  }
  setTimeout(): unknown {
    throw new Error("pairing does not schedule timers");
  }
  clearTimeout(): void {}
}

const OWNER = "owner@example.ts.net";
const MACHINE = { id: "machine-1", name: "Mac" };
const ROUTES = { direct: "https://mac.tailnet.ts.net", secure: "https://bridge.example.test" };
const BRIDGE_KEY = "a".repeat(43);

async function setup() {
  const fs = new MapFs();
  const devices = await DeviceStore.open(fs, "/state/devices.json", new FakeClock());
  const pairing = new PairingCodes(new FakeClock());
  const context: ApiContext = {
    identity: { ownerLogin: OWNER },
    devices,
    pairing,
    machine: MACHINE,
    routes: () => ROUTES,
    bridgeKey: () => BRIDGE_KEY,
  };
  return { fs, devices, pairing, context };
}

function ownerHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ "Tailscale-User-Login": OWNER, ...extra });
}

function request(
  path: string,
  options: { method?: string; headers?: Headers; body?: string } = {},
): Request {
  return new Request(`https://bridge.test${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
}

describe("handleApi", () => {
  test("rejects missing identity before reading the request body", async () => {
    const { context } = await setup();
    let bodyRead = false;
    const incoming = request("/api/pair", { method: "POST", body: "{}" });
    Object.defineProperty(incoming, "json", {
      value: async () => {
        bodyRead = true;
        return {};
      },
    });

    const response = await handleApi(incoming, context);
    expect(response?.status).toBe(403);
    expect(bodyRead).toBe(false);
    expect(await response?.json()).toEqual({ error: "forbidden" });

    bodyRead = false;
    const mismatched = request("/api/pair", {
      method: "POST",
      headers: new Headers({ "Tailscale-User-Login": "someone-else@example.ts.net" }),
      body: "{}",
    });
    Object.defineProperty(mismatched, "json", {
      value: async () => {
        bodyRead = true;
        return {};
      },
    });
    const mismatchResponse = await handleApi(mismatched, context);
    expect(mismatchResponse?.status).toBe(403);
    expect(bodyRead).toBe(false);
  });

  test("redeems a pairing code once and returns a token backed by a stored hash", async () => {
    const { fs, devices, pairing, context } = await setup();
    const issued = pairing.issue("control", "Desk phone");
    const incoming = request("/api/pair", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ code: issued.code }),
    });

    const response = await handleApi(incoming, context);
    expect(response?.status).toBe(201);
    const reply = (await response?.json()) as PairReply;
    expect(reply).toMatchObject({
      role: "control",
      machine: MACHINE,
      routes: ROUTES,
      bridgeKey: BRIDGE_KEY,
    });
    expect(reply.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await devices.findByToken(reply.token)).toMatchObject({
      id: reply.deviceId,
      name: "Desk phone",
      role: "control",
    });
    expect(fs.files.get("/state/devices.json")).not.toContain(reply.token);

    const replay = await handleApi(
      request("/api/pair", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ code: issued.code }),
      }),
      context,
    );
    expect(replay?.status).toBe(400);
    expect(await replay?.json()).toEqual({ error: "bad_code" });
  });

  test("requires a device token after identity and returns only device views", async () => {
    const { devices, context } = await setup();
    const device = await devices.add({ token: "phone-token", role: "watch", name: "Phone" });

    const missing = await handleApi(request("/api/health", { headers: ownerHeaders() }), context);
    expect(missing?.status).toBe(401);

    const response = await handleApi(
      request("/api/devices", {
        headers: ownerHeaders({ Authorization: "Bearer phone-token" }),
      }),
      context,
    );
    expect(response?.status).toBe(200);
    const body = await response?.text();
    expect(body).toContain(device.id);
    expect(body).toContain("Phone");
    expect(body).not.toContain("tokenHash");
    expect(body).not.toContain("phone-token");
  });

  test("lets a device revoke itself and rejects its token afterward", async () => {
    const { devices, context } = await setup();
    const caller = await devices.add({ token: "self-token", role: "watch" });

    const revoked = await handleApi(
      request("/api/devices/self", {
        method: "DELETE",
        headers: ownerHeaders({ Authorization: "Bearer self-token" }),
      }),
      context,
    );
    expect(revoked?.status).toBe(204);

    const health = await handleApi(
      request("/api/health", {
        headers: ownerHeaders({ Authorization: "Bearer self-token" }),
      }),
      context,
    );
    expect(health?.status).toBe(401);
    expect(await devices.revoke(caller.id)).toBe(false);
  });

  test("watch devices cannot revoke another device, while control devices can", async () => {
    const { devices, context } = await setup();
    const watch = await devices.add({ token: "watch-token", role: "watch" });
    const target = await devices.add({ token: "target-token", role: "watch" });

    const denied = await handleApi(
      request(`/api/devices/${target.id}`, {
        method: "DELETE",
        headers: ownerHeaders({ Authorization: "Bearer watch-token" }),
      }),
      context,
    );
    expect(denied?.status).toBe(403);
    expect(await devices.findByToken("target-token")).toBeDefined();

    const control = await devices.add({ token: "control-token", role: "control" });
    const allowed = await handleApi(
      request(`/api/devices/${target.id}`, {
        method: "DELETE",
        headers: ownerHeaders({ Authorization: "Bearer control-token" }),
      }),
      context,
    );
    expect(allowed?.status).toBe(204);
    expect(await devices.findByToken("target-token")).toBeUndefined();
    expect(await devices.findByToken("watch-token")).toMatchObject({ id: watch.id });
    expect(await devices.findByToken("control-token")).toMatchObject({ id: control.id });
  });

  test("returns undefined for non-API paths and rejects unknown API routes after auth", async () => {
    const { devices, context } = await setup();
    await devices.add({ token: "known-token", role: "watch" });

    expect(await handleApi(request("/index.html"), context)).toBeUndefined();
    const unknown = await handleApi(
      request("/api/unknown", {
        headers: ownerHeaders({ Authorization: "Bearer known-token" }),
      }),
      context,
    );
    expect(unknown?.status).toBe(404);
  });
});
