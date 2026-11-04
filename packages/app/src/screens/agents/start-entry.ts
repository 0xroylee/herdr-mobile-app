import type { Role } from "@herdr-mobile/protocol";

/** Agents shows the Start action only to control devices. */
export function showAgentsStartEntryPoint(role: Role | undefined): boolean {
  return role === "control";
}
