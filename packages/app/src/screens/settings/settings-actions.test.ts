/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import type { Machine } from "../../store/machines.ts";
import { createMachinesStore } from "../../store/machines.ts";
import { createMemorySecrets, createMemoryStorage } from "../../store/memory.ts";
import {
  createMachineRemovalController,
  machineHostName,
  removePairedMachine,
} from "./settings-actions.ts";

const machine: Machine = {
  id: "mac-1",
  name: "MacBook",
  routes: { direct: "https://mac.tailnet.ts.net" },
  role: "control",
  deviceId: "device-1",
};

describe("machine settings actions", () => {
  test("revokes the current device and removes its local secret and machine", async () => {
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    const requests: { url: string; method?: string; authorization: string | null }[] = [];
    const result = await withFetch(
      async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return new Response(null, { status: 204 });
      },
      () => removePairedMachine(machine, secrets, machines),
    );

    expect(result).toEqual({ revoked: true });
    expect(requests).toEqual([
      {
        url: "https://mac.tailnet.ts.net/api/devices/self",
        method: "DELETE",
        authorization: "Bearer device-token",
      },
    ]);
    expect(machines.getState().machines).toEqual({});
    expect(await secrets.get(machine.id)).toBeNull();
  });

  test("forgets the local machine when the bridge cannot be reached", async () => {
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    const result = await withFetch(
      async () => {
        throw new TypeError("network unavailable");
      },
      () => removePairedMachine(machine, secrets, machines),
    );

    expect(result).toEqual({ revoked: false });
    expect(machines.getState().machines).toEqual({});
    expect(await secrets.get(machine.id)).toBeNull();
  });

  test("owns confirmation and removal progress and message state", async () => {
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    let confirmationTitle: string | undefined;
    const controller = createMachineRemovalController(secrets, machines, async (options) => {
      confirmationTitle = options.title;
      return false;
    });

    const removal = controller.remove(machine);
    expect(controller.getSnapshot().confirming).toBe(true);
    await removal;

    expect(confirmationTitle).toBe("Remove MacBook?");
    expect(controller.getSnapshot().confirming).toBe(false);
    expect(machines.getState().machines[machine.id]).toEqual(machine);
  });

  test("keeps the unreachable active-machine warning after another Mac becomes active", async () => {
    const other: Machine = {
      ...machine,
      id: "mac-2",
      name: "Other Mac",
      deviceId: "device-2",
      routes: { direct: "https://other.tailnet.ts.net" },
    };
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    machines.getState().addMachine(other);
    let activeId = machines.getState().activeId;
    const unsubscribe = machines.subscribe((state) => {
      activeId = state.activeId;
    });
    const manager = { calls: () => unavailableBridgeCalls("The Mac is offline.") };
    const controller = createMachineRemovalController(
      secrets,
      machines,
      async () => true,
      (candidate) => (candidate.id === activeId ? manager : undefined),
    );

    await controller.remove(machine);

    expect(machines.getState().activeId).toBe(other.id);
    expect(machines.getState().machines[other.id]).toBeDefined();
    expect(controller.getSnapshot().message).toContain("did not confirm revocation");
    unsubscribe();
  });

  test("parses the machine hostname for display", () => {
    expect(machineHostName(machine)).toBe("mac.tailnet.ts.net");
    expect(machineHostName({ ...machine, routes: {} })).toBe("MacBook");
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
