import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { TerminalTable } from "../../model/terminals.ts";
import type { MachineCoreState } from "../../store/core.ts";
import { coreStore, machinesStore, seenStore, settingsStore } from "../../store/platform.ts";
import {
  agentSearchFilter,
  countAgents,
  deriveAgentSections,
  selectActiveAgentMachine,
  startAgentAgeRefresh,
  toggleAgentSort,
} from "./agents-view.ts";

const emptyTerminals: TerminalTable = {};
const emptyCore: MachineCoreState = {
  connection: "offline",
  terminals: emptyTerminals,
  layout: undefined,
  snapshotAt: null,
};

/** Select the active machine's agent data and refresh display ages every 30 seconds. */
export function useAgents(query: string) {
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machineRecords = useStore(machinesStore, (state) => state.machines);
  const setActiveId = useStore(machinesStore, (state) => state.setActiveId);
  const sort = useStore(settingsStore, (state) => state.agents.sort);
  const setSort = useStore(settingsStore, (state) => state.setAgentSort);
  const seen = useStore(seenStore, (state) => state.seen);
  const coreByMachine = useStore(coreStore, (state) => state.machines);
  const activeMachine = selectActiveAgentMachine(
    activeId,
    machineRecords,
    coreByMachine,
    emptyCore,
  );
  const { machine, core: activeCore } = activeMachine;
  const machines = useMemo(() => Object.values(machineRecords), [machineRecords]);
  const connections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(coreByMachine).map(([id, state]) => [id, state.connection]),
      ),
    [coreByMachine],
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    return startAgentAgeRefresh(() => setNow(Date.now()));
  }, []);

  const filter = useMemo(() => agentSearchFilter(query), [query]);
  const { sections, allSections, spaceSections } = useMemo(
    () => deriveAgentSections(activeId, activeCore, seen, now, sort, filter),
    [activeCore, activeId, filter, now, seen, sort],
  );
  const toggleSort = () => toggleAgentSort(sort, setSort);

  return {
    activeId,
    agentCount: countAgents(allSections),
    connection: activeCore.connection,
    connections,
    machine,
    machines,
    sections,
    setActiveId,
    toggleSort,
    sort,
    spaceCount: activeCore.layout?.spaces.length ?? spaceSections.length,
  };
}
