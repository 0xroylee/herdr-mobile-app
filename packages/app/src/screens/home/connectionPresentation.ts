import { machinesStore } from "@/store/platform.ts";
import type { ConnectionState } from "../../store/core.ts";

export type ConnectionBanner =
  | { kind: "reconnecting"; message: string; action: "none" }
  | { kind: "offline"; message: string; action: "retry" }
  | { kind: "unauthorized"; message: string; action: "pair" };

export interface ConnectionPresentation {
  dimmed: boolean;
  banner: ConnectionBanner | undefined;
}

const disconnectedBanners: Record<
  Exclude<ConnectionState, "connected">,
  (machine: string, secureRouteAvailable: boolean) => ConnectionBanner
> = {
  connecting: (machine) => ({
    kind: "reconnecting",
    message: `Connecting to ${machine}…`,
    action: "none",
  }),
  reconnecting: (machine) => ({
    kind: "reconnecting",
    message: `Reconnecting to ${machine}…`,
    action: "none",
  }),
  offline: (_machine, secureRouteAvailable) => ({
    kind: "offline",
    message: secureRouteAvailable
      ? "Can't reach your Mac. Check it's awake and online."
      : "Can't reach the bridge. Check that Tailscale is on.",
    action: "retry",
  }),
  unauthorized: (machine) => ({
    kind: "unauthorized",
    message: `This device is no longer paired with ${machine}.`,
    action: "pair",
  }),
  identity_changed: () => ({
    kind: "unauthorized",
    message: "This Mac's bridge identity changed.",
    action: "pair",
  }),
};

/** Describe stale content and recovery from the active connection state. */
export function connectionPresentation(
  connection: ConnectionState | undefined,
  machineName: string | undefined,
  secureRouteAvailable = activeMachineHasSecureRoute(),
): ConnectionPresentation {
  if (connection === undefined || connection === "connected") {
    return { dimmed: false, banner: undefined };
  }

  const machine = machineName?.trim() || "Mac";
  return {
    dimmed: true,
    banner: disconnectedBanners[connection](machine, secureRouteAvailable),
  };
}

function activeMachineHasSecureRoute(): boolean {
  const { activeId, machines } = machinesStore.getState();
  return activeId !== null && machines[activeId]?.routes.secure !== undefined;
}
