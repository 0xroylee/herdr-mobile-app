import {
  applyEvent,
  applySnapshot,
  type HcEvent,
  type Layout,
  type Status,
  type TasksDocument,
  type Terminal,
  type TerminalTable,
} from "@herdr-mobile/protocol";
import { create } from "zustand";

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
  lastSeenStatuses?: Readonly<Record<string, Status>>;
  layout: Layout | undefined;
  tasks?: TasksDocument;
  snapshotAt: number | null;
}

export interface CoreStore {
  machines: Record<string, MachineCoreState>;
  setConnection(machineId: string, connection: ConnectionState, route?: "direct" | "secure"): void;
  removeMachine(machineId: string): void;
  setSnapshot(machineId: string, terminals: readonly Terminal[], at: number): void;
  applyEvent(machineId: string, event: HcEvent, at: number): void;
  setLayout(machineId: string, layout: Layout | undefined): void;
  setTasks(machineId: string, tasks: TasksDocument): void;
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
    removeMachine: (machineId) =>
      set((state) => {
        if (state.machines[machineId] === undefined) return state;
        const machines = { ...state.machines };
        delete machines[machineId];
        return { machines };
      }),
    setSnapshot: (machineId, terminals, at) =>
      set((state) => {
        const current = state.machines[machineId] ?? emptyMachineCore();
        return {
          machines: {
            ...state.machines,
            [machineId]: {
              ...current,
              terminals: applySnapshot(terminals),
              lastSeenStatuses: rememberSnapshotStatuses(current.lastSeenStatuses ?? {}, terminals),
              snapshotAt: at,
            },
          },
        };
      }),
    applyEvent: (machineId, event, at) =>
      set((state) => {
        const current = state.machines[machineId] ?? emptyMachineCore();
        if (event.type === "missed") {
          const data = asRecord(event.data);
          const records = data?.terminals;
          if (Array.isArray(records)) {
            const terminals = applySnapshot(records as Terminal[]);
            return {
              machines: {
                ...state.machines,
                [machineId]: {
                  ...current,
                  terminals,
                  lastSeenStatuses: rememberSnapshotStatuses(
                    current.lastSeenStatuses ?? {},
                    Object.values(terminals),
                  ),
                  snapshotAt: at,
                },
              },
            };
          }
          return state;
        }
        const terminals = applyEvent(current.terminals, event, at);
        const terminalAddress = event.type === "status" ? event.terminal : undefined;
        const lastSeenStatuses =
          terminalAddress === undefined
            ? current.lastSeenStatuses
            : rememberStatus(
                current.lastSeenStatuses ?? {},
                terminalAddress,
                terminals[terminalAddress]?.status,
              );
        return {
          machines: {
            ...state.machines,
            [machineId]: { ...current, terminals, lastSeenStatuses },
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
    setTasks: (machineId, tasks) =>
      set((state) => ({
        machines: {
          ...state.machines,
          [machineId]: { ...emptyMachineCore(), ...state.machines[machineId], tasks },
        },
      })),
  }));
}

function emptyMachineCore(): MachineCoreState {
  return {
    connection: "offline",
    terminals: {},
    lastSeenStatuses: {},
    layout: undefined,
    tasks: emptyTasksDocument(),
    snapshotAt: null,
  };
}

function rememberSnapshotStatuses(
  previous: Readonly<Record<string, Status>>,
  terminals: readonly Terminal[],
): Readonly<Record<string, Status>> {
  return terminals.reduce(
    (statuses, terminal) => rememberStatus(statuses, terminal.address, terminal.status),
    previous,
  );
}

function rememberStatus(
  previous: Readonly<Record<string, Status>>,
  address: string,
  status: Status | null | undefined,
): Readonly<Record<string, Status>> {
  return status == null ? previous : { ...previous, [address]: status };
}

function emptyTasksDocument(): TasksDocument {
  return { v: 1, tasks: {} };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
