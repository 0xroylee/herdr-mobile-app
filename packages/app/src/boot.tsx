import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { type ConnectionManager, createConnectionManager } from "./net/connection.ts";
import { startLifecycle } from "./store/lifecycle.ts";
import type { Machine } from "./store/machines.ts";
import {
  appSecrets,
  coreStore,
  machinesStore,
  seenStore,
  settingsStore,
} from "./store/platform.ts";
import { applyTheme } from "./ui/theme.ts";

export const ConnectionManagerContext = createContext<ConnectionManager | undefined>(undefined);

export function useConnectionManager(): ConnectionManager | undefined {
  return useContext(ConnectionManagerContext);
}

export function Boot({ children, onReady }: { children: ReactNode; onReady(): void }) {
  const [manager, setManager] = useState<ConnectionManager | undefined>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    return startLifecycle({
      stores: { settings: settingsStore, machines: machinesStore, seen: seenStore },
      secrets: appSecrets,
      appState: {
        currentState: () => AppState.currentState,
        subscribe: (listener) => {
          const subscription = AppState.addEventListener("change", listener);
          return () => subscription.remove();
        },
      },
      applyTheme,
      createManager: (machine: Machine, secrets) =>
        createConnectionManager({
          machine,
          secrets,
          core: coreStore.getState(),
          updateRoutes: (id, routes) => machinesStore.getState().updateRoutes(id, routes),
          getMachine: (id) => machinesStore.getState().machines[id],
        }),
      onManager: setManager,
      onReady: () => {
        setReady(true);
        onReady();
      },
    });
  }, [onReady]);

  return (
    <ConnectionManagerContext.Provider value={manager}>
      {ready ? children : null}
    </ConnectionManagerContext.Provider>
  );
}
