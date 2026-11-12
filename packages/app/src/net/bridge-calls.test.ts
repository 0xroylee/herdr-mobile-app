/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Machine } from "../store/machines.ts";
import { createMemorySecrets } from "../store/memory.ts";
import { bridgeCallsFor, unavailableBridgeCalls } from "./bridge-calls.ts";

const directMachine: Machine = {
  id: "machine-1",
  name: "MacBook Pro",
  routes: { direct: "https://mac.tailnet.ts.net" },
  role: "control",
  deviceId: "device-1",
};

describe("BridgeCalls", () => {
  test("uses the direct route and token for an off-manager machine", async () => {
    const secrets = createMemorySecrets([[directMachine.id, "device-token"]]);
    const callsSeen: { url: string; authorization: string | null }[] = [];
    await withFetch(
      async (input, init) => {
        callsSeen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({ ok: true });
      },
      async () => {
        await expect(bridgeCallsFor(directMachine, secrets).health()).resolves.toEqual({
          ok: true,
        });
      },
    );

    expect(callsSeen).toEqual([
      { url: "https://mac.tailnet.ts.net/api/health", authorization: "Bearer device-token" },
    ]);
  });

  test("delegates to a supplied connection manager", () => {
    const delegated = unavailableBridgeCalls("manager selected");
    const manager = { calls: () => delegated };

    expect(bridgeCallsFor(directMachine, createMemorySecrets(), manager)).toBe(delegated);
  });

  test("rejects without a direct route with the not_connected API error shape", async () => {
    const machine: Machine = { ...directMachine, routes: {} };

    await expect(bridgeCallsFor(machine, createMemorySecrets()).health()).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 503,
      code: "not_connected",
      message: "Not connected to MacBook Pro.",
    });
  });
});

async function withFetch<T>(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  action: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher as typeof globalThis.fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}
