import type { ConnectionManager } from "../net/connection.ts";
import type { Machine } from "./machines.ts";
import type { ThemeChoice } from "./settings.ts";

interface RehydratableStore {
  persist: { rehydrate(): unknown; hasHydrated(): boolean };
}

export interface LifecycleStores {
  settings: RehydratableStore & { getState(): { ui: { theme: ThemeChoice } } };
  machines: RehydratableStore & {
    getState(): { activeId: string | null; machines: Record<string, Machine> };
    subscribe(listener: () => void): () => void;
  };
  seen: RehydratableStore;
}

export interface LifecycleAppStateSource {
  currentState(): string | null | undefined;
  subscribe(listener: (state: string | null | undefined) => void): () => void;
}

export interface LifecycleOptions {
  stores: LifecycleStores;
  appState: LifecycleAppStateSource;
  applyTheme(theme: ThemeChoice): void;
  createManager(
    machine: Machine,
    restartConnection: (machineId: string) => void,
  ): ConnectionManager;
  onManager(manager: ConnectionManager | undefined): void;
  onReady(): void;
}

/** Hydrate persisted app state before applying the theme, exposing readiness, and starting a manager. */
export function startLifecycle(options: LifecycleOptions): () => void {
  let disposed = false;
  let ready = false;
  let foreground = false;
  let manager: ConnectionManager | undefined;
  let activeMachineId: string | undefined;
  let managerMachineId: string | undefined;
  let machineRevision = 0;
  let unsubscribeMachines = () => {};

  const stopManager = () => {
    const current = manager;
    manager = undefined;
    managerMachineId = undefined;
    if (!current) return;
    current.stop();
    options.onManager(undefined);
  };

  let restartActiveManager = (_machineId: string) => {};

  const createManager = (machine: Machine, revision: number) => {
    let created: ConnectionManager | undefined;
    try {
      created = options.createManager(machine, (machineId) => {
        if (manager !== created || managerMachineId !== machine.id) return;
        restartActiveManager(machineId);
      });
    } catch {
      return;
    }
    if (disposed || revision !== machineRevision || activeMachineId !== machine.id) {
      created.stop();
      return;
    }

    manager = created;
    managerMachineId = machine.id;
    options.onManager(created);
    if (disposed || revision !== machineRevision || manager !== created) {
      created.stop();
      return;
    }
    if (foreground) created.start();
  };

  restartActiveManager = (machineId) => {
    if (disposed || activeMachineId !== machineId || managerMachineId !== machineId || !manager) {
      return;
    }
    const { activeId, machines } = options.stores.machines.getState();
    const currentMachine = activeId ? machines[activeId] : undefined;
    if (currentMachine?.id !== machineId) return;

    const revision = ++machineRevision;
    stopManager();
    if (disposed || revision !== machineRevision) return;
    createManager(currentMachine, revision);
  };

  const updateForeground = (state: string | null | undefined) => {
    foreground = state === "active" || state == null;
    if (!ready) return;
    if (foreground) manager?.start();
    else manager?.stop();
  };

  const unsubscribeAppState = options.appState.subscribe(updateForeground);
  updateForeground(options.appState.currentState());

  const syncActiveMachine = () => {
    const { activeId, machines } = options.stores.machines.getState();
    const nextMachine = activeId ? machines[activeId] : undefined;
    if (nextMachine?.id === activeMachineId) return;

    const revision = ++machineRevision;
    activeMachineId = nextMachine?.id;
    stopManager();
    if (disposed || revision !== machineRevision || !nextMachine) return;
    createManager(nextMachine, revision);
  };

  const hydrate = async () => {
    const hydrationResults = await Promise.all([
      runHydration(options.stores.settings),
      runHydration(options.stores.machines),
      runHydration(options.stores.seen),
    ]);
    if (disposed) return;

    let theme: ThemeChoice = "system";
    if (hydrationResults[0]) {
      try {
        theme = options.stores.settings.getState().ui.theme;
      } catch {
        theme = "system";
      }
    }
    try {
      options.applyTheme(theme);
    } catch {
      try {
        options.applyTheme("system");
      } catch {
        // Readiness still follows a failed platform theme update.
      }
    }
    if (disposed) return;

    ready = true;
    unsubscribeMachines = options.stores.machines.subscribe(syncActiveMachine);
    syncActiveMachine();
    options.onReady();
  };

  void hydrate();

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeAppState();
    unsubscribeMachines();
    const hadManager = manager !== undefined;
    stopManager();
    if (!hadManager) options.onManager(undefined);
  };
}

async function runHydration(store: RehydratableStore): Promise<boolean> {
  try {
    await store.persist.rehydrate();
    return store.persist.hasHydrated();
  } catch {
    return false;
  }
}
