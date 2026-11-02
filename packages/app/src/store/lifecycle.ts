import type { ConnectionManager } from "../net/connection.ts";
import type { Machine } from "./machines.ts";
import type { Secrets } from "./secrets.ts";
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
  secrets: Secrets;
  appState: LifecycleAppStateSource;
  applyTheme(theme: ThemeChoice): void;
  createManager(machine: Machine, secrets: Secrets): ConnectionManager;
  onManager(manager: ConnectionManager | undefined): void;
  onReady(): void;
}

/** Hydrate persisted app state before applying the theme, exposing readiness, and starting a manager. */
export function startLifecycle(options: LifecycleOptions): () => void {
  let disposed = false;
  let ready = false;
  let foreground = false;
  let manager: ConnectionManager | undefined;
  let selectedMachine: Machine | undefined;
  let unsubscribeMachines = () => {};

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
    if (nextMachine?.id === selectedMachine?.id && nextMachine === selectedMachine) return;

    manager?.stop();
    manager = undefined;
    options.onManager(undefined);
    selectedMachine = nextMachine;
    if (!nextMachine) return;

    try {
      manager = options.createManager(nextMachine, options.secrets);
    } catch {
      return;
    }
    options.onManager(manager);
    if (foreground) manager.start();
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
    manager?.stop();
    manager = undefined;
    options.onManager(undefined);
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
