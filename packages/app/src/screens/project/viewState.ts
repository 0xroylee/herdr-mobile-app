import type { Layout } from "@herdr-mobile/protocol";
import type { SpaceRow } from "../../model/spaces.ts";
import type { EffectiveState } from "../../model/status.ts";

export const tabPillHitSlop = { top: 7, bottom: 7, left: 6, right: 6 } as const;
export const terminalsListScrollClassName = "min-h-0 flex-1";
export const terminalsListContentClassName = "flex-row flex-wrap content-start gap-1.5 pb-3";

/** Convert a label-backed display route into the terminal's actual space label. */
export function projectTaskId(projectId: string, layout: Layout | undefined): string {
  if (layout?.spaces.some((space) => space.id === projectId)) return projectId;
  return projectId.startsWith("label-space:") ? projectId.slice("label-space:".length) : projectId;
}

/** Resolve a layout space by id, or a label-backed space by its stored label value. */
export function findProjectSpace(
  projectId: string,
  layout: Layout | undefined,
  spaces: readonly SpaceRow[],
): SpaceRow | undefined {
  const direct = spaces.find((space) => space.id === projectId);
  if (direct !== undefined || layout !== undefined) return direct;

  const labelId = projectTaskId(projectId, undefined);
  return spaces.find((space) =>
    space.tabs.some((tab) =>
      tab.terminals.some((terminal) => terminal.labels["herdr.space"] === labelId),
    ),
  );
}

export function tabDotState(state: EffectiveState): "blocked" | "done" | undefined {
  return state === "blocked" || state === "done" ? state : undefined;
}

export function firstTerminalAddress(
  terminals: readonly { address: string }[],
): string | undefined {
  return terminals[0]?.address;
}
