/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { unavailableBridgeCalls } from "../net/bridge-calls.ts";
import type { ConnectionManager } from "../net/connection.ts";
import { type LifecycleAppStateSource, type LifecycleStores, startLifecycle } from "./lifecycle.ts";
import { createMachinesStore, type Machine } from "./machines.ts";
import { createMemorySecrets, createMemoryStorage } from "./memory.ts";
import { createSeenStore } from "./seen.ts";
import type { ThemeChoice } from "./settings.ts";
import { createSettingsStore } from "./settings.ts";
import type { Storage } from "./storage.ts";

const machine: Machine = {
  id: "machine-1",
  name: "Mac",
  routes: { direct: "https://mac.tailnet.ts.net" },
  role: "control",
  deviceId: "device-1",
};

describe("app lifecycle", () => {
  test("applies an active-to-background change made during hydration before starting a manager", async () => {
    const fixture = createFixture("paper", "active");
    const dispose = startLifecycle(fixture.options);

    fixture.appState.emit("background");
    expect(fixture.managers[0]?.starts).toBeUndefined();
    fixture.resolveHydration();
    await fixture.settle();

    expect(fixture.ready).toBe(true);
    expect(fixture.managers[0]?.starts).toBe(0);
    fixture.appState.emit("active");
    expect(fixture.managers[0]?.starts).toBe(1);
    dispose();
  });

  test("applies a background-to-active change made during hydration after it", async () => {
    const fixture = createFixture("graphite", "background");
    const dispose = startLifecycle(fixture.options);

    fixture.appState.emit("active");
    expect(fixture.managers).toHaveLength(0);
    fixture.resolveHydration();
    await fixture.settle();

    expect(fixture.managers[0]?.starts).toBe(1);
    expect(fixture.ready).toBe(true);
    dispose();
  });

  test("applies the saved theme before reporting readiness", async () => {
    const fixture = createFixture("paper", "active");
    const dispose = startLifecycle(fixture.options);
    fixture.resolveHydration();
    await fixture.settle();

    expect(fixture.order.indexOf("theme:paper")).toBeLessThan(fixture.order.indexOf("ready"));
    dispose();
  });

  test("keeps the manager for route and key changes from machine store writes", async () => {
    const fixture = createFixture("paper", "active");
    const dispose = startLifecycle(fixture.options);
    fixture.resolveHydration();
    await fixture.settle();
    const firstManager = fixture.managers[0];

    fixture.machines.update({
      ...machine,
      routes: { direct: "https://updated.tailnet.ts.net" },
    });
    await fixture.settle();

    expect(fixture.managers).toHaveLength(1);
    expect(firstManager?.stops).toBe(0);

    fixture.machines.update({
      ...machine,
      routes: {
        direct: "https://updated.tailnet.ts.net",
        secure: { url: "https://edge.example.test", key: "first-key" },
      },
    });
    await fixture.settle();

    fixture.machines.update({
      ...machine,
      routes: {
        direct: "https://updated.tailnet.ts.net",
        secure: { url: "https://edge.example.test", key: "rotated-key" },
      },
    });
    await fixture.settle();

    expect(fixture.managers).toHaveLength(1);
    expect(firstManager?.stops).toBe(0);
    dispose();
  });

  test("replaces the manager when the active machine changes or is removed", async () => {
    const fixture = createFixture("paper", "active");
    const dispose = startLifecycle(fixture.options);
    fixture.resolveHydration();
    await fixture.settle();
    const firstManager = fixture.managers[0];

    fixture.machines.select({
      ...machine,
      id: "machine-2",
      name: "Other Mac",
      deviceId: "device-2",
    });

    expect(fixture.managers).toHaveLength(2);
    expect(firstManager?.stops).toBe(1);
    expect(fixture.managers[1]?.starts).toBe(1);

    fixture.machines.removeActive();

    expect(fixture.managers[1]?.stops).toBe(1);
    dispose();
  });

  test("restartConnection replaces the active manager once", async () => {
    const fixture = createFixture("paper", "active");
    const dispose = startLifecycle(fixture.options);
    fixture.resolveHydration();
    await fixture.settle();
    const firstManager = fixture.managers[0];

    firstManager?.restartConnection(machine.id);

    expect(fixture.managers).toHaveLength(2);
    expect(firstManager?.stops).toBe(1);
    expect(fixture.managers[1]?.starts).toBe(1);
    dispose();
  });

  test("settings storage failure applies the default theme and still reports readiness", async () => {
    const fixture = createPersistedFixture({ persistedTheme: "paper", failingKey: "settings" });
    const dispose = startLifecycle(fixture.options);
    await fixture.readyPromise;

    expect(fixture.order).toEqual(["theme:system", "ready"]);
    expect(fixture.ready).toBe(true);
    dispose();
  });

  test("a seen storage failure keeps the hydrated settings theme and still reports readiness", async () => {
    const fixture = createPersistedFixture({ persistedTheme: "paper", failingKey: "seen" });
    const dispose = startLifecycle(fixture.options);
    await fixture.readyPromise;

    expect(fixture.order).toEqual(["theme:paper", "ready"]);
    expect(fixture.ready).toBe(true);
    dispose();
  });

  test("unreadable settings JSON applies the default theme and still reports readiness", async () => {
    const fixture = createPersistedFixture({ unreadableSettings: true });
    const dispose = startLifecycle(fixture.options);
    await fixture.readyPromise;

    expect(fixture.order).toEqual(["theme:system", "ready"]);
    expect(fixture.ready).toBe(true);
    dispose();
  });
});

function createFixture(theme: ThemeChoice, initialState: string | null) {
  let resolveHydration = () => {};
  let hydrated = false;
  const hydration = new Promise<void>((resolve) => {
    resolveHydration = () => {
      hydrated = true;
      resolve();
    };
  });
  const persist = { rehydrate: () => hydration, hasHydrated: () => hydrated };
  const order: string[] = [];
  const settings = {
    persist,
    getState: () => ({ ui: { theme } }),
  };
  const machines = createMachinesLifecycleStore(persist);
  const seen = { persist };
  const stores: LifecycleStores = { settings, machines: machines.store, seen };
  const appState = createAppState(initialState);
  const managers: {
    starts: number;
    stops: number;
    restartConnection(machineId: string): void;
  }[] = [];
  let ready = false;
  const options = {
    stores,
    appState,
    applyTheme: (choice: ThemeChoice) => order.push(`theme:${choice}`),
    createManager: (_machine: Machine, restartConnection: (machineId: string) => void) => {
      const record = { starts: 0, stops: 0, restartConnection };
      managers.push(record);
      return fakeManager(
        () => {
          record.starts += 1;
        },
        () => {
          record.stops += 1;
        },
        restartConnection,
      );
    },
    onManager: () => {},
    onReady: () => {
      ready = true;
      order.push("ready");
    },
  };

  return {
    options,
    appState,
    managers,
    machines,
    order,
    get ready() {
      return ready;
    },
    resolveHydration,
    settle: async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    },
  };
}

function createMachinesLifecycleStore(persist: {
  rehydrate(): Promise<void>;
  hasHydrated(): boolean;
}) {
  const listeners = new Set<() => void>();
  let state: { activeId: string | null; machines: Record<string, Machine> } = {
    activeId: machine.id,
    machines: { [machine.id]: machine },
  };
  return {
    store: {
      persist,
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    update(nextMachine: Machine) {
      state = {
        ...state,
        machines: { ...state.machines, [nextMachine.id]: nextMachine },
      };
      for (const listener of listeners) listener();
    },
    select(nextMachine: Machine) {
      state = {
        activeId: nextMachine.id,
        machines: { ...state.machines, [nextMachine.id]: nextMachine },
      };
      for (const listener of listeners) listener();
    },
    removeActive() {
      if (!state.activeId) return;
      const machines = { ...state.machines };
      delete machines[state.activeId];
      state = { activeId: null, machines };
      for (const listener of listeners) listener();
    },
  };
}

function createPersistedFixture(options: {
  persistedTheme?: ThemeChoice;
  failingKey?: string;
  unreadableSettings?: boolean;
}) {
  const backingStorage = createMemoryStorage();
  if (options.persistedTheme) {
    createSettingsStore(backingStorage).getState().setTheme(options.persistedTheme);
  }
  if (options.unreadableSettings) backingStorage.setItem("settings", "not valid JSON");

  const storage: Storage = {
    getItem: (key) => {
      if (key === options.failingKey) throw new Error(`storage unavailable for ${key}`);
      return backingStorage.getItem(key);
    },
    setItem: (key, value) => backingStorage.setItem(key, value),
    removeItem: (key) => backingStorage.removeItem(key),
  };
  const secrets = createMemorySecrets();
  const stores: LifecycleStores = {
    settings: createSettingsStore(storage),
    machines: createMachinesStore(storage, secrets),
    seen: createSeenStore(storage),
  };
  const order: string[] = [];
  let ready = false;
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const appState = createAppState("active");
  const lifecycleOptions = {
    stores,
    appState,
    applyTheme: (theme: ThemeChoice) => order.push(`theme:${theme}`),
    createManager: (_machine: Machine, restartConnection: (machineId: string) => void) =>
      fakeManager(
        () => {},
        () => {},
        restartConnection,
      ),
    onManager: () => {},
    onReady: () => {
      ready = true;
      order.push("ready");
      resolveReady();
    },
  };

  return {
    options: lifecycleOptions,
    order,
    readyPromise,
    get ready() {
      return ready;
    },
  };
}

function createAppState(initialState: string | null) {
  let state = initialState;
  const listeners = new Set<(next: string | null) => void>();
  const source: LifecycleAppStateSource & { emit(state: string | null): void } = {
    currentState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
  return source;
}

function fakeManager(
  start: () => void,
  stop: () => void,
  restartConnection: (machineId: string) => void,
): ConnectionManager {
  return {
    start,
    stop,
    restartConnection,
    attach: async () => {
      throw new Error("not used by lifecycle tests");
    },
    call: async () => {
      throw new Error("not used by lifecycle tests");
    },
    calls: () => unavailableBridgeCalls("not used by lifecycle tests"),
    state: () => "offline",
    subscribe: () => () => {},
  };
}
