import type { BridgeCalls } from "../../net/bridge-calls.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import type { ConnectionManager } from "../../net/connection.ts";
import { createNewSpace, type NewItemMachine, type NewItemResult } from "../../net/new-items.ts";
import type { SettingsStore } from "../../store/settings.ts";
import type { NewTaskContext, NewTaskController, NewTaskPort } from "./new-task-controller.ts";

export interface NewTaskPreferences {
  rememberRun(machineId: string, run: Parameters<NewTaskPort["rememberRun"]>[1]): void;
  rememberFolder(machineId: string, folder: string): void;
}

/** Bind either task-entry screen to its active connection manager, settings, and context. */
export function bindNewTaskScreen(
  controller: NewTaskController,
  manager: Pick<ConnectionManager, "calls"> | undefined,
  context: NewTaskContext,
  settings: Pick<SettingsStore, "setLastRun" | "pushRecentFolder">,
): void {
  const calls = manager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac.");
  controller.setPort(
    createNewTaskPort(calls, {
      rememberRun: (machineId, run) => settings.setLastRun(machineId, run),
      rememberFolder: (machineId, folder) => settings.pushRecentFolder(machineId, folder),
    }),
  );
  controller.setContext(context);
}

/** Safe initial port; screens replace it with the current binding before use. */
export const unavailableNewTaskPort = createNewTaskPort(
  unavailableBridgeCalls("Not connected to the selected Mac."),
  { rememberRun: () => undefined, rememberFolder: () => undefined },
);

/** Bind the task controller to bridge requests and per-machine settings. */
export function createNewTaskPort(
  calls: Pick<BridgeCalls, "agentCatalog" | "startTask">,
  preferences: NewTaskPreferences,
): NewTaskPort {
  return {
    catalog: () => calls.agentCatalog(),
    start: (request) => calls.startTask(request),
    rememberRun: (machineId, run) => preferences.rememberRun(machineId, run),
    rememberFolder: (machineId, folder) => preferences.rememberFolder(machineId, folder),
  };
}

/** Keep Home's project form on the existing role and error handling path. */
export function createHomeProject(
  calls: Pick<BridgeCalls, "appDo">,
  machine: NewItemMachine | undefined,
  name: string,
  folder: string,
): Promise<NewItemResult> {
  const fields = {
    ...(name.trim().length > 0 ? { name: name.trim() } : {}),
    ...(folder.trim().length > 0 ? { folder: folder.trim() } : {}),
  };
  return createNewSpace(
    {
      calls: {
        appDo: (action, args) =>
          calls.appDo(action, action === "space.new" ? { ...args, ...fields } : args),
      },
    },
    machine,
  );
}
