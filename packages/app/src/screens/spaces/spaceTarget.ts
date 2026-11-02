import type { Layout } from "@herdr-mobile/protocol";
import type { SpaceRow } from "@/model/spaces.ts";

declare const spaceTargetBrand: unique symbol;

export type SpaceTargetId = string & { readonly [spaceTargetBrand]: true };

/** Resolve a new-tab target from document ids or unanimous terminal labels. */
export function newTabTarget(
  space: SpaceRow,
  layout: Layout | undefined,
): SpaceTargetId | undefined {
  if (layout !== undefined) {
    const documentSpace = layout.spaces.find((candidate) => candidate.id === space.id);
    if (documentSpace === undefined) return undefined;

    const tabIdsMatch =
      documentSpace.tabs.length === space.tabs.length &&
      documentSpace.tabs.every((tab, index) => tab.id === space.tabs[index]?.id);
    return tabIdsMatch ? (documentSpace.id as SpaceTargetId) : undefined;
  }

  const terminals = space.tabs.flatMap((tab) => tab.terminals);
  if (terminals.length === 0) return undefined;

  const target = terminals[0]?.labels["herdr.space"]?.trim();
  if (
    target === undefined ||
    target.length === 0 ||
    terminals.some((terminal) => terminal.labels["herdr.space"]?.trim() !== target)
  ) {
    return undefined;
  }

  return target as SpaceTargetId;
}
