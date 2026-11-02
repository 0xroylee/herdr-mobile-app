import type { Role } from "@herdr-mobile/protocol";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "./persist.ts";
import type { Secrets } from "./secrets.ts";
import type { Storage } from "./storage.ts";

export interface Machine {
  id: string;
  name: string;
  url: string;
  role: Role;
  deviceId: string;
}

export interface MachinesValues {
  machines: Record<string, Machine>;
  activeId: string | null;
}

export interface MachinesStore extends MachinesValues {
  addMachine(machine: Machine): void;
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
        version: 1,
        storage: createPersistStorage<MachinesValues>(storage),
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
    url: machine.url,
    role: machine.role,
    deviceId: machine.deviceId,
  };
}
