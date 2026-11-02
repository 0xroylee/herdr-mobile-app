import type { MachineSpaceGroup } from "@/model/spaces.ts";
import type { EffectiveState } from "@/model/status.ts";

export const tabPillVisual = { height: 30, addWidth: 33 } as const;
export const tabPillHitSlop = { top: 7, bottom: 7, left: 6, right: 6 } as const;
export const minimumTapTarget = 44;

export const spacesFootnote =
  "New spaces and tabs open in Herdr on your Mac, so it has to be running.";

export function getSpaceExpansionKey(groupId: string, spaceId: string): string {
  return JSON.stringify([groupId, spaceId]);
}

export function initialExpandedSpaceKeys(groups: readonly MachineSpaceGroup[]): string[] {
  for (const group of groups) {
    const firstSpace = group.spaces[0];
    if (firstSpace !== undefined) return [getSpaceExpansionKey(group.id, firstSpace.id)];
  }
  return [];
}

export function toggleExpandedSpace(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

export function groupHeading(group: MachineSpaceGroup, activeMachineName?: string): string {
  if (group.machine !== undefined) return group.label;
  return activeMachineName?.trim() || group.label;
}

export function groupTag(group: MachineSpaceGroup): "this Mac" | "ssh" {
  return group.machine === undefined ? "this Mac" : "ssh";
}

export function tabDotState(state: EffectiveState): "blocked" | "done" | undefined {
  return state === "blocked" || state === "done" ? state : undefined;
}

export function firstTerminalAddress(
  terminals: readonly { address: string }[],
): string | undefined {
  return terminals[0]?.address;
}
