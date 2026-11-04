import type { Role } from "@herdr-mobile/protocol";

export interface StartScreenAccess {
  readOnly: boolean;
  canStart: boolean;
}

/** Describes the Start screen's role and connection limits. */
export function getStartScreenAccess(
  role: Role | undefined,
  connected: boolean,
): StartScreenAccess {
  const isControl = role === "control";
  return { readOnly: !isControl, canStart: isControl && connected };
}
