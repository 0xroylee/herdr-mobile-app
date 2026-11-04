import type { Role } from "@herdr-mobile/protocol";

/** Expanded spaces show the Start action only to control devices. */
export function showSpaceStartEntryPoint(role: Role | undefined): boolean {
  return role === "control";
}
