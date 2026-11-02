import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { AdminApiContext } from "./admin-routes.ts";
import { handleAdminApi } from "./admin-routes.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
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

describe("handleAdminApi", () => {
  test("issues a local pair code and reports its expiry", async () => {
    const devices = await DeviceStore.open(new MapFs(), "/state/devices.json", new FakeClock());
    await devices.add({ token: "status-token", role: "watch" });
    const pairing = new PairingCodes(new FakeClock());
    const context: AdminApiContext = {
      devices,
      pairing,
      status: () => ({
        machine: { id: "machine-1", name: "Mac" },
        publicUrl: "https://mac.tailnet.ts.net",
        listen: "127.0.0.1:8787",
        sessions: 2,
      }),
    };

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
      devices: 1,
    });
  });

  test("lists and revokes devices on the admin socket", async () => {
    const devices = await DeviceStore.open(new MapFs(), "/state/devices.json", new FakeClock());
    const device = await devices.add({ token: "admin-token", role: "watch" });
    const context: AdminApiContext = {
      devices,
      pairing: new PairingCodes(),
      status: () => ({
        machine: { id: "machine-1", name: "Mac" },
        publicUrl: "https://mac.tailnet.ts.net",
        listen: "127.0.0.1:8787",
        sessions: 0,
      }),
    };

    const list = await handleAdminApi(request("/devices"), context);
    expect(await list?.json()).toEqual([device]);
    const deleted = await handleAdminApi(request(`/devices/${device.id}`, "DELETE"), context);
    expect(deleted?.status).toBe(204);
    expect(await devices.findByToken("admin-token")).toBeUndefined();
    expect(await handleAdminApi(request("/not-admin"), context)).toBeUndefined();
  });
});
