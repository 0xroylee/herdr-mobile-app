import type { Role } from "@herdr-mobile/protocol";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "./persist.ts";
import type { Secrets } from "./secrets.ts";
import type { Storage } from "./storage.ts";

export interface Machine {
  id: string;
  name: string;
  routes: MachineRoutes;
  role: Role;
  deviceId: string;
}

export interface MachineRoutes {
  direct?: string;
  secure?: { url: string; key: string };
}

export interface MachinesValues {
  machines: Record<string, Machine>;
  activeId: string | null;
}

export interface MachinesStore extends MachinesValues {
  addMachine(machine: Machine): void;
  updateRoutes(id: string, routes: MachineRoutes): void;
  setActiveId(id: string | null): void;
  forgetMachine(id: string): Promise<void>;
}

export function createMachinesStore(storage: Storage, secrets: Secrets) {
  return create<MachinesStore>()(
    persist(
      (set) => ({
        machines: {},
        activeId: null,
        addMachine: (machine) =>
          set((state) => {
            const safeMachine = copyMachine(machine);
            return {
              machines: { ...state.machines, [safeMachine.id]: safeMachine },
              activeId: state.activeId ?? safeMachine.id,
            };
          }),
        updateRoutes: (id, routes) =>
          set((state) => {
            const machine = state.machines[id];
            if (!machine) return state;
            return {
              machines: {
                ...state.machines,
                [id]: { ...machine, routes: copyRoutes(routes) },
              },
            };
          }),
        setActiveId: (id) =>
          set((state) => ({ activeId: id !== null && state.machines[id] ? id : null })),
        forgetMachine: async (id) => {
          await secrets.remove(id);
          set((state) => {
            if (!state.machines[id]) return state;
            const machines = { ...state.machines };
            delete machines[id];
            const activeId =
              state.activeId === id ? (Object.keys(machines)[0] ?? null) : state.activeId;
            return { machines, activeId };
          });
        },
      }),
      {
        name: "machines",
        version: 2,
        storage: createPersistStorage<MachinesValues>(storage),
        migrate: migrateMachines,
        skipHydration: true,
        partialize: ({ machines, activeId }) => ({ machines, activeId }),
      },
    ),
  );
}

/** Copy only the public machine fields so an accidental token property cannot be persisted. */
function copyMachine(machine: Machine): Machine {
  return {
    id: machine.id,
    name: machine.name,
    routes: copyRoutes(machine.routes),
    role: machine.role,
    deviceId: machine.deviceId,
  };
}

function copyRoutes(routes: MachineRoutes): MachineRoutes {
  return {
    ...(routes.direct === undefined ? {} : { direct: routes.direct }),
    ...(routes.secure === undefined
      ? {}
      : { secure: { url: routes.secure.url, key: routes.secure.key } }),
  };
}

function migrateMachines(persisted: unknown, version: number): MachinesValues {
  if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted)) {
    return { machines: {}, activeId: null };
  }

  const state = persisted as Record<string, unknown>;
  const storedMachines = state.machines;
  if (
    typeof storedMachines !== "object" ||
    storedMachines === null ||
    Array.isArray(storedMachines)
  ) {
    return { machines: {}, activeId: null };
  }

  const machines: Record<string, Machine> = {};
  for (const [id, value] of Object.entries(storedMachines)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      (record.role !== "watch" && record.role !== "control") ||
      typeof record.deviceId !== "string"
    ) {
      continue;
    }

    const routes =
      version < 2
        ? typeof record.url === "string"
          ? { direct: record.url }
          : {}
        : copyStoredRoutes(record.routes);
    machines[id] = {
      id: record.id,
      name: record.name,
      routes,
      role: record.role,
      deviceId: record.deviceId,
    };
  }

  return {
    machines,
    activeId:
      typeof state.activeId === "string" && machines[state.activeId] ? state.activeId : null,
  };
}

function copyStoredRoutes(value: unknown): MachineRoutes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const routes = value as Record<string, unknown>;
  const direct = typeof routes.direct === "string" ? routes.direct : undefined;
  const secure = routes.secure;
  const secureRecord =
    typeof secure === "object" && secure !== null && !Array.isArray(secure)
      ? (secure as Record<string, unknown>)
      : undefined;
  const secureRoute =
    typeof secureRecord?.url === "string" && typeof secureRecord.key === "string"
      ? { url: secureRecord.url, key: secureRecord.key }
      : undefined;
  return {
    ...(direct === undefined ? {} : { direct }),
    ...(secureRoute === undefined ? {} : { secure: secureRoute }),
  };
}
