import type { EffectiveState } from "../../model/status.ts";

export const tabPillHitSlop = { top: 7, bottom: 7, left: 6, right: 6 } as const;

export function tabDotState(state: EffectiveState): "blocked" | "done" | undefined {
  return state === "blocked" || state === "done" ? state : undefined;
}

export function firstTerminalAddress(
  terminals: readonly { address: string }[],
): string | undefined {
  return terminals[0]?.address;
}
