import type { HcEvent, Layout, Terminal } from "@herdr-mobile/protocol";
import { create } from "zustand";
import { applyEvent, applySnapshot, type TerminalTable } from "../model/terminals.ts";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "unauthorized"
  | "identity_changed";

export interface MachineCoreState {
  connection: ConnectionState;
  route?: "direct" | "secure";
  terminals: TerminalTable;
  layout: Layout | undefined;
  snapshotAt: number | null;
}

export interface CoreStore {
  machines: Record<string, MachineCoreState>;
  setConnection(machineId: string, connection: ConnectionState, route?: "direct" | "secure"): void;
  setSnapshot(machineId: string, terminals: readonly Terminal[], at: number): void;
  applyEvent(machineId: string, event: HcEvent, at: number): void;
  setLayout(machineId: string, layout: Layout | undefined): void;
}

export function createCoreStore() {
  return create<CoreStore>()((set) => ({
    machines: {},
    setConnection: (machineId, connection, route) =>
      set((state) => ({
        machines: {
          ...state.machines,
          [machineId]: {
            ...emptyMachineCore(),
            ...state.machines[machineId],
            connection,
            route: connection === "connected" ? route : undefined,
          },
        },
      })),
    setSnapshot: (machineId, terminals, at) =>
      set((state) => ({
        machines: {
          ...state.machines,
          [machineId]: {
            ...emptyMachineCore(),
            ...state.machines[machineId],
            terminals: applySnapshot(terminals),
            snapshotAt: at,
          },
        },
      })),
    applyEvent: (machineId, event, at) =>
      set((state) => {
        const current = state.machines[machineId] ?? emptyMachineCore();
        if (event.type === "missed") {
          const data = asRecord(event.data);
          const records = data?.terminals;
          if (Array.isArray(records)) {
            return {
              machines: {
                ...state.machines,
                [machineId]: {
                  ...current,
                  terminals: applySnapshot(records as Terminal[]),
                  snapshotAt: at,
                },
              },
            };
          }
          return state;
        }
        return {
          machines: {
            ...state.machines,
            [machineId]: { ...current, terminals: applyEvent(current.terminals, event, at) },
          },
        };
      }),
    setLayout: (machineId, layout) =>
      set((state) => ({
        machines: {
          ...state.machines,
          [machineId]: { ...emptyMachineCore(), ...state.machines[machineId], layout },
        },
      })),
  }));
}

function emptyMachineCore(): MachineCoreState {
  return { connection: "offline", terminals: {}, layout: undefined, snapshotAt: null };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
