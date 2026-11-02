import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "./persist.ts";
import type { Storage } from "./storage.ts";

export type ThemeChoice = "system" | "graphite" | "paper";
export type AgentSort = "priority" | "space";

export interface SettingsValues {
  ui: { theme: ThemeChoice };
  agents: { sort: AgentSort };
  notify: { blocked: boolean; done: boolean };
}

export interface SettingsStore extends SettingsValues {
  setTheme(theme: ThemeChoice): void;
  setAgentSort(sort: AgentSort): void;
  setNotifications(notify: SettingsValues["notify"]): void;
  setNotifyBlocked(enabled: boolean): void;
  setNotifyDone(enabled: boolean): void;
}

const defaults: SettingsValues = {
  ui: { theme: "system" },
  agents: { sort: "priority" },
  notify: { blocked: true, done: false },
};

export function createSettingsStore(storage: Storage) {
  return create<SettingsStore>()(
    persist(
      (set) => ({
        ...defaults,
        setTheme: (theme) => set((state) => ({ ui: { ...state.ui, theme } })),
        setAgentSort: (sort) => set((state) => ({ agents: { ...state.agents, sort } })),
        setNotifications: (notify) => set({ notify }),
        setNotifyBlocked: (blocked) => set((state) => ({ notify: { ...state.notify, blocked } })),
        setNotifyDone: (done) => set((state) => ({ notify: { ...state.notify, done } })),
      }),
      {
        name: "settings",
        version: 1,
        storage: createPersistStorage<SettingsValues>(storage),
        skipHydration: true,
        partialize: ({ ui, agents, notify }) => ({ ui, agents, notify }),
      },
    ),
  );
}
