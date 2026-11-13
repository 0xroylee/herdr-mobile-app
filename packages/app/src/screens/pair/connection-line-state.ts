import type { ConnectionState } from "../../store/core.ts";

export interface ConnectionLineState {
  message: string;
  tone: "done" | "muted" | "danger";
  indicator: "done" | "working" | "blocked";
}

export function connectionLineState(
  state: ConnectionState | undefined,
  machineName: string,
  deviceName: string,
  route?: "direct" | "secure",
): ConnectionLineState {
  switch (state) {
    case "connected": {
      return {
        message:
          route === "secure"
            ? "Connected via the secure route"
            : route === "direct"
              ? "Connected via Tailscale"
              : `Connected as ${deviceName}`,
        tone: "done",
        indicator: "done",
      };
    }
    case "unauthorized":
      return {
        message: "Pairing must be repeated for this device.",
        tone: "danger",
        indicator: "blocked",
      };
    case "offline":
      return {
        message: `Disconnected from ${machineName}.`,
        tone: "muted",
        indicator: "blocked",
      };
    case "reconnecting":
      return {
        message: `Reconnecting to ${machineName}…`,
        tone: "muted",
        indicator: "working",
      };
    default:
      return {
        message: `Connecting to ${machineName}…`,
        tone: "muted",
        indicator: "working",
      };
  }
}
