import type { Layout, Role } from "@herdr-mobile/protocol";
import type { SpaceRow } from "../../model/spaces.ts";
import { newTabTarget, type SpaceTargetId } from "../../model/spaceTarget.ts";

/** Resolve a Start target only for control devices and spaces that can receive a tab. */
export function spaceStartTarget(
  role: Role | undefined,
  row: SpaceRow,
  layout: Layout | undefined,
): SpaceTargetId | undefined {
  return role === "control" ? newTabTarget(row, layout) : undefined;
}
