import { bridgeCallsFor } from "../../net/bridge-calls.ts";
import type { ConnectionManager } from "../../net/connection.ts";
import type { Machine } from "../../store/machines.ts";
import type { machinesStore } from "../../store/platform.ts";
import type { Secrets } from "../../store/secrets.ts";
import type { confirm as showConfirmation } from "../../ui/components/Confirm";

export interface MachineRemovalState {
  confirming: boolean;
  removingId?: string;
  message?: string;
}

type MachineManagerResolver = (machine: Machine) => Pick<ConnectionManager, "calls"> | undefined;

/** Try to revoke this device remotely, then always forget its local token and machine. */
export async function removePairedMachine(
  machine: Machine,
  secrets: Secrets,
  machines: typeof machinesStore,
  manager?: Pick<ConnectionManager, "calls">,
): Promise<{ revoked: boolean }> {
  let revoked = false;

  try {
    await bridgeCallsFor(machine, secrets, manager).revoke("self");
    revoked = true;
  } catch {
    // The bridge may be offline; removing the local credentials must still finish.
  }

  await machines.getState().forgetMachine(machine.id);
  return { revoked };
}

/** Own confirmation, progress, and result state for removing a paired machine. */
export function createMachineRemovalController(
  secrets: Secrets,
  machines: typeof machinesStore,
  confirmRemoval: typeof showConfirmation,
  managerFor?: MachineManagerResolver,
) {
  let state: MachineRemovalState = { confirming: false };
  const listeners = new Set<() => void>();

  const update = (next: MachineRemovalState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async remove(machine: Machine): Promise<void> {
      if (state.confirming || state.removingId) return;
      update({ confirming: true });

      let accepted = false;
      try {
        accepted = await confirmRemoval({
          title: `Remove ${machine.name}?`,
          message:
            "We'll revoke this device if the bridge is reachable, then remove it from this phone.",
          confirmLabel: "Remove",
        });
      } catch {
        accepted = false;
      }
      if (!accepted) {
        update({ confirming: false });
        return;
      }

      update({ confirming: false, removingId: machine.id });
      try {
        const result = await removePairedMachine(machine, secrets, machines, managerFor?.(machine));
        update({
          confirming: false,
          removingId: machine.id,
          message: result.revoked
            ? undefined
            : "Removed from this phone, but the bridge did not confirm revocation. Remove the old device from the bridge if it still appears.",
        });
      } catch {
        update({
          confirming: false,
          removingId: machine.id,
          message: "Couldn't remove this device from local storage. Try again.",
        });
      } finally {
        update({ ...state, confirming: false, removingId: undefined });
      }
    },
  };
}

export function machineHostName(machine: Machine): string {
  try {
    const url = machine.routes.direct ?? machine.routes.secure?.url;
    return url === undefined ? machine.name : new URL(url).host;
  } catch {
    return machine.name;
  }
}

/** Label each configured way to reach this Mac with the route's host. */
export function machineRouteLines(machine: Machine): string[] {
  const lines: string[] = [];
  if (machine.routes.direct) {
    lines.push(`Tailscale: ${routeHost(machine.routes.direct)}`);
  }
  if (machine.routes.secure) {
    lines.push(`Secure route: ${routeHost(machine.routes.secure.url)}`);
  }
  return lines;
}

function routeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
