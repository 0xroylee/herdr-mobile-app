import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { AdminApiContext } from "./admin-routes.ts";
import { handleAdminApi } from "./admin-routes.ts";
import { createAdvertisedRoutes } from "./advertised-routes.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
import { encodePublicKey, openIdentityKey } from "./identity-key.ts";
import { PairingCodes } from "./pairing.ts";

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

function request(path: string, method = "GET", body?: string): Request {
  return new Request(`http://admin${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body,
  });
}

async function createContext(options: { securePort?: number; secureUrl?: string } = {}) {
  const fs = new MapFs();
  const devices = await DeviceStore.open(fs, "/state/devices.json", new FakeClock());
  const identity = await openIdentityKey("/state/identity.json", fs, new FakeClock());
  const routes = createAdvertisedRoutes({
    direct: "https://mac.tailnet.ts.net",
    ...(options.secureUrl === undefined ? {} : { secure: options.secureUrl }),
  });
  const context: AdminApiContext = {
    devices,
    pairing: new PairingCodes(new FakeClock()),
    routes,
    identity,
    ...(options.securePort === undefined ? {} : { securePort: options.securePort }),
    status: () => ({
      machine: { id: "machine-1", name: "Mac" },
      publicUrl: "https://mac.tailnet.ts.net",
      listen: "127.0.0.1:8787",
      sessions: 2,
    }),
  };
  return { context, devices, identity, routes };
}

describe("handleAdminApi", () => {
  test("issues a local pair code and reports its expiry", async () => {
    const { context, devices } = await createContext({
      securePort: 9443,
      secureUrl: "https://bridge.example.test",
    });
    await devices.add({ token: "status-token", role: "watch" });

    const response = await handleAdminApi(
      request("/pair-code", "POST", JSON.stringify({ role: "control", name: "Phone" })),
      context,
    );
    if (!response) throw new Error("pair-code route returned no response");
    expect(response.status).toBe(201);
    const issued = (await response.json()) as { code: string; expiresAt: number };
    expect(issued).toMatchObject({ expiresAt: 1_600_000 });
    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/u);

    const status = await handleAdminApi(request("/status"), context);
    expect(await status?.json()).toEqual({
      machine: { id: "machine-1", name: "Mac" },
      publicUrl: "https://mac.tailnet.ts.net",
      listen: "127.0.0.1:8787",
      sessions: 2,
      bridgeKey: expect.any(String),
      secure: { port: 9443, url: "https://bridge.example.test" },
      devices: 1,
    });
  });

  test("lists and revokes devices on the admin socket", async () => {
    const { context, devices } = await createContext();
    const device = await devices.add({ token: "admin-token", role: "watch" });

    const list = await handleAdminApi(request("/devices"), context);
    expect(await list?.json()).toEqual([device]);
    const deleted = await handleAdminApi(request(`/devices/${device.id}`, "DELETE"), context);
    expect(deleted?.status).toBe(204);
    expect(await devices.findByToken("admin-token")).toBeUndefined();
    expect(await handleAdminApi(request("/not-admin"), context)).toBeUndefined();
  });

  test("sets only an allowed secure origin and clears it", async () => {
    const { context, routes } = await createContext({ securePort: 9443 });
    const updated = await handleAdminApi(
      request("/secure-url", "PUT", JSON.stringify({ url: "http://192.168.1.5:9443/" })),
      context,
    );
    expect(updated?.status).toBe(200);
    expect(await updated?.json()).toEqual({ url: "http://192.168.1.5:9443" });
    expect(routes.snapshot()).toEqual({
      direct: "https://mac.tailnet.ts.net",
      secure: "http://192.168.1.5:9443",
    });

    const rejected = await handleAdminApi(
      request("/secure-url", "PUT", JSON.stringify({ url: "http://example.test" })),
      context,
    );
    expect(rejected?.status).toBe(400);

    const cleared = await handleAdminApi(request("/secure-url", "DELETE"), context);
    expect(cleared?.status).toBe(204);
    expect(routes.snapshot()).toEqual({ direct: "https://mac.tailnet.ts.net" });
  });

  test("returns 409 when no secure listener is configured", async () => {
    const { context } = await createContext();
    const response = await handleAdminApi(
      request("/secure-url", "PUT", JSON.stringify({ url: "https://bridge.example.test" })),
      context,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "secure_port_disabled" });
  });

  test("rotates the identity and returns only the new public key", async () => {
    const { context, identity } = await createContext();
    const before = identity.current();
    const response = await handleAdminApi(request("/identity/rotate", "POST"), context);
    const body = (await response?.text()) ?? "";
    const reply = JSON.parse(body) as { bridgeKey: string };

    expect(response?.status).toBe(200);
    expect(reply.bridgeKey).toBe(encodePublicKey(identity.current().publicKey));
    expect(reply.bridgeKey).not.toBe(encodePublicKey(before.publicKey));
    expect(body).not.toContain(encodePublicKey(identity.current().secretKey));
  });
});
