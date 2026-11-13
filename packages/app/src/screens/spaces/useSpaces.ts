import type { Layout } from "@herdr-mobile/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useConnectionManager } from "@/boot.tsx";
import { deriveSpaces, type MachineSpaceGroup } from "@/model/spaces.ts";
import type { SpaceTargetId } from "@/model/spaceTarget.ts";
import { unavailableBridgeCalls } from "@/net/bridge-calls.ts";
import type { Machine } from "@/store/machines.ts";
import { coreStore, machinesStore } from "@/store/platform.ts";
import {
  connectionPresentation,
  type SpacesConnectionPresentation,
} from "./connectionPresentation.ts";
import { createNewSpace, createNewTab, type NewItemResult } from "./newItems.ts";
import { initialExpandedSpaceKeys, toggleExpandedSpace } from "./viewState.ts";

export interface UseSpacesResult {
  groups: MachineSpaceGroup[];
  machine: Machine | undefined;
  presentation: SpacesConnectionPresentation;
  layout: Layout | undefined;
  canCreate: boolean;
  expandedSpaceKeys: string[];
  isCreating: boolean;
  message: string | undefined;
  isExpanded(key: string): boolean;
  toggleSpace(key: string): void;
  createSpace(): void;
  createTab(target: SpaceTargetId): void;
}

export function useSpaces(): UseSpacesResult {
  const connectionManager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const groups = useMemo(
    () => deriveSpaces(core?.terminals ?? {}, core?.layout),
    [core?.layout, core?.terminals],
  );
  const defaultExpandedKeys = useMemo(() => initialExpandedSpaceKeys(groups), [groups]);
  const [expandedOverride, setExpandedOverride] = useState<string[] | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState<string>();
  const actionInProgress = useRef(false);
  const expandedSpaceKeys = expandedOverride ?? defaultExpandedKeys;
  const presentation = connectionPresentation(core?.connection, machine?.name);
  const calls =
    connectionManager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac.");

  const isExpanded = useCallback(
    (key: string) => expandedSpaceKeys.includes(key),
    [expandedSpaceKeys],
  );
  const toggleSpace = useCallback(
    (key: string) => {
      setExpandedOverride((current) => toggleExpandedSpace(current ?? defaultExpandedKeys, key));
    },
    [defaultExpandedKeys],
  );

  const createItem = useCallback(
    async (item: { kind: "space" } | { kind: "tab"; target: SpaceTargetId }) => {
      if (actionInProgress.current || machine?.role !== "control") return;
      actionInProgress.current = true;
      setIsCreating(true);
      setMessage(undefined);
      const result: NewItemResult =
        item.kind === "space"
          ? await createNewSpace({ calls }, machine)
          : await createNewTab({ calls }, machine, item.target);
      if (!result.ok) setMessage(result.message);
      setIsCreating(false);
      actionInProgress.current = false;
    },
    [calls, machine],
  );

  const createSpace = useCallback(() => {
    void createItem({ kind: "space" });
  }, [createItem]);
  const createTab = useCallback(
    (target: SpaceTargetId) => {
      void createItem({ kind: "tab", target });
    },
    [createItem],
  );

  return {
    groups,
    machine,
    presentation,
    layout: core?.layout,
    canCreate: machine?.role === "control",
    expandedSpaceKeys,
    isCreating,
    message,
    isExpanded,
    toggleSpace,
    createSpace,
    createTab,
  };
}
