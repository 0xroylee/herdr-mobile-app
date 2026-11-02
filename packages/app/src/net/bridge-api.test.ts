/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { type BridgeApiError, type BridgeFetch, createBridgeApi } from "./bridge-api.ts";

describe("bridge API", () => {
  test("uses the bridge paths, bearer token and request payloads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: BridgeFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/pair")) {
        return Response.json({
          deviceId: "device-1",
          token: "one-time-token",
          role: "control",
          machine: { id: "machine-1", name: "Mac" },
        });
      }
      if (String(input).endsWith("/api/devices")) {
        return Response.json([
          { id: "device-1", name: "Phone", role: "control", createdAt: 1, lastSeenAt: null },
        ]);
      }
      if (String(input).includes("/api/devices/")) return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    };
    const api = createBridgeApi(fetcher);

    const pair = await api.pair("https://mac.tailnet.ts.net/", { code: "ABCD2345", name: "Phone" });
    await api.health("https://mac.tailnet.ts.net", "token");
    const devices = await api.devices("https://mac.tailnet.ts.net", "token");
    await api.revoke("https://mac.tailnet.ts.net", "token", "self");
    await api.appLs("https://mac.tailnet.ts.net", "token");
    await api.appDo("https://mac.tailnet.ts.net", "token", "space.new", { name: "Docs" });

    expect(pair.token).toBe("one-time-token");
    expect(devices[0]?.id).toBe("device-1");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://mac.tailnet.ts.net/api/pair",
      "https://mac.tailnet.ts.net/api/health",
      "https://mac.tailnet.ts.net/api/devices",
      "https://mac.tailnet.ts.net/api/devices/self",
      "https://mac.tailnet.ts.net/api/app/ls",
      "https://mac.tailnet.ts.net/api/app/do",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBeNull();
    expect(new Headers(calls[1]?.init.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "ABCD2345", name: "Phone" });
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({
      action: "space.new",
      args: { name: "Docs" },
    });
  });

  test("surfaces structured HTTP errors", async () => {
    const api = createBridgeApi(async () =>
      Response.json(
        { error: "herdr_not_running", message: "Herdr isn't running on your Mac" },
        { status: 409 },
      ),
    );

    await expect(api.appLs("https://mac.tailnet.ts.net", "token")).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 409,
      code: "herdr_not_running",
      message: "Herdr isn't running on your Mac",
    } satisfies Partial<BridgeApiError>);
  });
});
