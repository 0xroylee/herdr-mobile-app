import { type BridgeApi, BridgeApiError } from "@/net/bridge-api.ts";
import type { Machine } from "@/store/machines.ts";
import type { Secrets } from "@/store/secrets.ts";
import type { SpaceTargetId } from "./spaceTarget.ts";

export const herdrNotRunningMessage = "Herdr isn't running on your Mac";

export interface NewItemDependencies {
  api: Pick<BridgeApi, "appDo">;
  secrets: Pick<Secrets, "get">;
}

export type NewItemMachine = Pick<Machine, "id" | "url" | "role">;

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
    const token = await dependencies.secrets.get(machine.id);
    if (token === null) {
      return { ok: false, message: "The access token for this Mac is unavailable." };
    }

    if (action === "space.new") {
      await dependencies.api.appDo(machine.url, token, action);
    } else {
      await dependencies.api.appDo(machine.url, token, action, { space });
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
