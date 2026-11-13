import type { ConnectionState } from "@/store/core.ts";

export type SpacesBanner =
  | { kind: "reconnecting"; message: string; action: "none" }
  | { kind: "offline"; message: string; action: "retry" }
  | { kind: "unauthorized"; message: string; action: "pair" };

export interface SpacesConnectionPresentation {
  dimmed: boolean;
  banner: SpacesBanner | undefined;
}

const disconnectedBanners: Record<
  Exclude<ConnectionState, "connected">,
  (machine: string) => SpacesBanner
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
  offline: () => ({
    kind: "offline",
    message: "Can't reach the bridge. Check that Tailscale is on.",
    action: "retry",
  }),
  unauthorized: (machine) => ({
    kind: "unauthorized",
    message: `This device is no longer paired with ${machine}.`,
    action: "pair",
  }),
  identity_changed: () => ({
    kind: "unauthorized",
    message: "This Mac's bridge identity changed. Pair again.",
    action: "pair",
  }),
};

/** Describe stale content and recovery from the active connection state. */
export function connectionPresentation(
  connection: ConnectionState | undefined,
  machineName: string | undefined,
): SpacesConnectionPresentation {
  if (connection === undefined || connection === "connected") {
    return { dimmed: false, banner: undefined };
  }

  const machine = machineName?.trim() || "Mac";
  return { dimmed: true, banner: disconnectedBanners[connection](machine) };
}
