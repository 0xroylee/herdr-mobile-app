/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { HcEvent, Terminal } from "@herdr-mobile/protocol";
import { seenKey } from "../model/seen.ts";
import { createCoreStore } from "./core.ts";
import { createMachinesStore, type Machine } from "./machines.ts";
import { createMemorySecrets, createMemoryStorage } from "./memory.ts";
import { createSeenStore } from "./seen.ts";
import { createSettingsStore } from "./settings.ts";
import type { Storage } from "./storage.ts";

describe("app stores", () => {
  test("persists settings through the storage seam and rehydrates them", async () => {
    const storage = createMemoryStorage();
    const first = createSettingsStore(storage);
    first.getState().setTheme("paper");
    first.getState().setAgentSort("space");
    first.getState().setNotifyDone(true);

    const hydrated = createSettingsStore(storage);
    await hydrated.persist.rehydrate();

    expect(hydrated.getState()).toMatchObject({
      ui: { theme: "paper" },
      agents: { sort: "space" },
      notify: { blocked: true, done: true },
    });
  });

  test("stores bridge details without ever persisting an accidental token field", async () => {
    const { storage, values } = recordableStorage();
    const machines = createMachinesStore(storage, createMemorySecrets());
    const machineWithAnExtraField = {
      id: "machine-1",
      name: "Mac",
      url: "https://mac.tailnet.ts.net",
      role: "control",
      deviceId: "device-1",
      token: "one-time-token",
    } as Machine;
    machines.getState().addMachine(machineWithAnExtraField);
    machines.getState().setActiveId("machine-1");

    const persisted = values.get("machines") ?? "";
    expect(machines.getState().machines["machine-1"]).not.toHaveProperty("token");
    expect(persisted).not.toContain("one-time-token");
    expect(persisted).not.toContain('"token"');
    expect(machines.getState().activeId).toBe("machine-1");
  });

  test("forgetting a machine removes its secret after a failed bridge revoke", async () => {
    const secrets = createMemorySecrets([["machine-1", "private-token"]]);
    const machines = createMachinesStore(createMemoryStorage(), secrets);
    machines.getState().addMachine({
      id: "machine-1",
      name: "Mac",
      url: "https://mac.tailnet.ts.net",
      role: "control",
      deviceId: "device-1",
    });
    const revoke = async () => {
      throw new Error("bridge unreachable");
    };

    await expect(revoke()).rejects.toThrow("bridge unreachable");
    await machines.getState().forgetMachine("machine-1");

    expect(machines.getState().machines["machine-1"]).toBeUndefined();
    expect(await secrets.get("machine-1")).toBeNull();
  });

  test("stores seen turns using U7's stable machine/address key", async () => {
    const seen = createSeenStore(createMemoryStorage());
    seen.getState().mark("machine-1", "box/t7", 4);

    expect(seen.getState().seen[seenKey("machine-1", "box/t7")]).toBe(4);
    expect(seen.getState().has("machine-1", "box/t7", 4)).toBe(true);
    expect(seen.getState().has("machine-1", "box/t7", 5)).toBe(false);
  });

  test("keeps terminal snapshots and events behind U7's reducer in a memory-only core store", () => {
    const core = createCoreStore();
    core.getState().setSnapshot("machine-1", [terminal("t1")], 100);
    core.getState().applyEvent("machine-1", event("turn", { turn: 2 }), 200);

    expect(core.getState().machines["machine-1"]?.terminals.t1?.turn).toBe(2);
    expect(core.getState().machines["machine-1"]?.snapshotAt).toBe(100);

    core.getState().applyEvent("machine-1", event("missed", { terminals: [terminal("t2")] }), 300);
    expect(Object.keys(core.getState().machines["machine-1"]?.terminals ?? {})).toEqual(["t2"]);
    expect(core.getState().machines["machine-1"]?.snapshotAt).toBe(300);
  });

  test("keeps memory storage and secrets as separate adapters", async () => {
    const storage = createMemoryStorage();
    const secrets = createMemorySecrets();
    await storage.setItem("settings", "plain-data");
    await secrets.set("machine-1", "private-token");

    expect(await storage.getItem("settings")).toBe("plain-data");
    expect(await secrets.get("machine-1")).toBe("private-token");
    await secrets.remove("machine-1");
    expect(await secrets.get("machine-1")).toBeNull();
    await storage.removeItem("settings");
    expect(await storage.getItem("settings")).toBeNull();
  });
});

function recordableStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { storage, values };
}

function terminal(address: string): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: "/repo",
    labels: {},
    pid: 1,
    records: {},
    reported: true,
    rows: 24,
    screen: "exact",
    state: "live",
    turn: 1,
  };
}

function event(type: string, data: unknown): HcEvent {
  return { seq: 1, type, terminal: "t1", data: data as HcEvent["data"] };
}
