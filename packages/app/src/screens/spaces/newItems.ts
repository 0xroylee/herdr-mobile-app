import type { SpaceTargetId } from "@/model/spaceTarget.ts";
import { BridgeApiError } from "@/net/bridge-api.ts";
import type { BridgeCalls } from "@/net/bridge-calls.ts";
import type { Machine } from "@/store/machines.ts";

export const herdrNotRunningMessage = "Herdr isn't running on your Mac";

export interface NewItemDependencies {
  calls: Pick<BridgeCalls, "appDo">;
}

export type NewItemMachine = Pick<Machine, "id" | "role">;

export type NewItemResult = { ok: true } | { ok: false; message: string };

export function createNewSpace(
  dependencies: NewItemDependencies,
  machine: NewItemMachine | undefined,
): Promise<NewItemResult> {
  return runNewItem(dependencies, machine, "space.new");
}

export function createNewTab(
  dependencies: NewItemDependencies,
  machine: NewItemMachine | undefined,
  space: SpaceTargetId,
): Promise<NewItemResult> {
  return runNewItem(dependencies, machine, "tab.new", space);
}

async function runNewItem(
  dependencies: NewItemDependencies,
  machine: NewItemMachine | undefined,
  action: "space.new" | "tab.new",
  space?: string,
): Promise<NewItemResult> {
  if (machine === undefined) return { ok: false, message: "No active Mac is selected." };
  if (machine.role !== "control") return { ok: false, message: "This device is read-only." };

  try {
    if (action === "space.new") {
      await dependencies.calls.appDo(action);
    } else {
      await dependencies.calls.appDo(action, { space });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: newItemErrorMessage(error, action) };
  }
}

function newItemErrorMessage(error: unknown, action: "space.new" | "tab.new"): string {
  if (error instanceof BridgeApiError && error.status === 409) return herdrNotRunningMessage;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return action === "space.new"
    ? "Couldn't create the space. Try again."
    : "Couldn't create the tab. Try again.";
}
