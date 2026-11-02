import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isSeen, markSeen, type SeenState } from "../model/seen.ts";
import { createPersistStorage } from "./persist.ts";
import type { Storage } from "./storage.ts";

export interface SeenStore {
  seen: SeenState;
  mark(machineId: string, address: string, turn: number): void;
  has(machineId: string, address: string, turn: number | undefined): boolean;
}

export function createSeenStore(storage: Storage) {
  return create<SeenStore>()(
    persist(
      (set, get) => ({
        seen: {},
        mark: (machineId, address, turn) =>
          set((state) => ({ seen: markSeen(state.seen, machineId, address, turn) })),
        has: (machineId, address, turn) => isSeen(get().seen, machineId, address, turn),
      }),
      {
        name: "seen",
        version: 1,
        storage: createPersistStorage<SeenState>(storage),
        skipHydration: true,
        partialize: ({ seen }) => ({ ...seen }),
        merge: (persisted, current) => ({ ...current, seen: (persisted ?? {}) as SeenState }),
      },
    ),
  );
}
