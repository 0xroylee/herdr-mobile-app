/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createBridgeApi } from "../../net/bridge-api.ts";
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
  url: "https://mac.tailnet.ts.net",
  role: "control",
  deviceId: "device-1",
};

describe("machine settings actions", () => {
  test("revokes the current device and removes its local secret and machine", async () => {
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    const requests: { url: string; method?: string; authorization: string | null }[] = [];
    const api = createBridgeApi(async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(null, { status: 204 });
    });

    const result = await removePairedMachine(machine, api, secrets, machines);

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
    const api = createBridgeApi(async () => {
      throw new TypeError("network unavailable");
    });

    const result = await removePairedMachine(machine, api, secrets, machines);

    expect(result).toEqual({ revoked: false });
    expect(machines.getState().machines).toEqual({});
    expect(await secrets.get(machine.id)).toBeNull();
  });

  test("owns confirmation and removal progress and message state", async () => {
    const secrets = createMemorySecrets([[machine.id, "device-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine(machine);
    let confirmationTitle: string | undefined;
    const controller = createMachineRemovalController(
      createBridgeApi(async () => new Response(null, { status: 204 })),
      secrets,
      machines,
      async (options) => {
        confirmationTitle = options.title;
        return false;
      },
    );

    const removal = controller.remove(machine);
    expect(controller.getSnapshot().confirming).toBe(true);
    await removal;

    expect(confirmationTitle).toBe("Remove MacBook?");
    expect(controller.getSnapshot().confirming).toBe(false);
    expect(machines.getState().machines[machine.id]).toEqual(machine);
  });

  test("parses the machine hostname for display", () => {
    expect(machineHostName(machine.url)).toBe("mac.tailnet.ts.net");
    expect(machineHostName("not a URL")).toBe("not a URL");
  });
});
