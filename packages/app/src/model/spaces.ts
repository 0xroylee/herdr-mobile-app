import type { Layout, Terminal } from "@herdr-mobile/protocol";
import { splitAddress } from "./address.ts";
import { type EffectiveState, effectiveState, mostUrgent } from "./status.ts";

export interface SpaceTabRow {
  id: string;
  name: string;
  state: EffectiveState;
  terminals: Terminal[];
}

export interface SpaceRow {
  id: string;
  name: string;
  state: EffectiveState;
  tabs: SpaceTabRow[];
}

export interface MachineSpaceGroup {
  id: string;
  label: string;
  machine: string | undefined;
  spaces: SpaceRow[];
}

/** Derive document-ordered spaces and tabs, grouped by the terminal's machine. */
export function deriveSpaces(
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>,
  layout: Layout | undefined,
): MachineSpaceGroup[] {
  const terminalList = toTerminalList(terminals);
  return layout === undefined
    ? deriveFromLabels(terminalList)
    : deriveFromLayout(terminalList, layout);
}

function deriveFromLayout(terminals: readonly Terminal[], layout: Layout): MachineSpaceGroup[] {
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  const groups = new Map<string | undefined, MachineSpaceGroup>();
  const placedAddresses = new Set<string>();

  for (const space of layout.spaces) {
    const spaceAddresses = space.tabs.flatMap((tab) => tab.terminalAddresses);
    const machines = uniqueAddressMachines(spaceAddresses);
    if (machines.length === 0) machines.push(undefined);

    for (const machine of machines) {
      const tabs = space.tabs.map((tab) => {
        const tabTerminals: Terminal[] = [];
        for (const address of tab.terminalAddresses) {
          if (machineOfAddress(address) !== machine) continue;
          const terminal = byAddress.get(address);
          if (terminal !== undefined) tabTerminals.push(terminal);
        }
        for (const terminal of tabTerminals) placedAddresses.add(terminal.address);
        return makeTab(tab.id, tab.name, tabTerminals);
      });
      const row: SpaceRow = {
        id: space.id,
        name: nonEmpty(space.name) ?? "Other",
        state: mostUrgent(tabs.map(({ state }) => state)),
        tabs,
      };
      ensureGroup(groups, machine).spaces.push(row);
    }
  }

  const unplaced = terminals.filter((terminal) => !placedAddresses.has(terminal.address));
  for (const [machine, machineTerminals] of groupByMachine(unplaced)) {
    const group = ensureGroup(groups, machine);
    const tab = makeTab("other-tab", "Other", machineTerminals);
    group.spaces.push({ id: "other", name: "Other", state: tab.state, tabs: [tab] });
  }

  return orderMachineGroups(groups);
}

function deriveFromLabels(terminals: readonly Terminal[]): MachineSpaceGroup[] {
  const groups = new Map<string | undefined, MachineSpaceGroup>();
  const spacesByMachine = new Map<string, Map<string, SpaceRow>>();

  for (const terminal of terminals) {
    const machine = machineOf(terminal);
    const group = ensureGroup(groups, machine);
    let machineSpaces = spacesByMachine.get(group.id);
    if (machineSpaces === undefined) {
      machineSpaces = new Map();
      spacesByMachine.set(group.id, machineSpaces);
    }

    const spaceName = nonEmpty(terminal.labels["herdr.space"]) ?? "Other";
    const tabName = nonEmpty(terminal.labels["herdr.tab"]) ?? "Other";
    let space = machineSpaces.get(spaceName);
    if (space === undefined) {
      space = { id: `label-space:${spaceName}`, name: spaceName, state: "idle", tabs: [] };
      machineSpaces.set(spaceName, space);
      group.spaces.push(space);
    }
    let tab = space.tabs.find(({ name }) => name === tabName);
    if (tab === undefined) {
      tab = {
        id: `label-tab:${spaceName}:${tabName}`,
        name: tabName,
        state: "idle",
        terminals: [],
      };
      space.tabs.push(tab);
    }
    tab.terminals.push(terminal);
    tab.state = mostUrgent(tab.terminals.map(stateOf));
    space.state = mostUrgent(space.tabs.map(({ state }) => state));
  }

  return orderMachineGroups(groups);
}

function makeTab(id: string, name: string, terminals: Terminal[]): SpaceTabRow {
  return {
    id,
    name: nonEmpty(name) ?? "Other",
    state: mostUrgent(terminals.map(stateOf)),
    terminals,
  };
}

function stateOf(terminal: Terminal): EffectiveState {
  return effectiveState(terminal.status, { terminalState: terminal.state });
}

function uniqueAddressMachines(addresses: readonly string[]): Array<string | undefined> {
  const machines: Array<string | undefined> = [];
  for (const address of addresses) {
    const machine = machineOfAddress(address);
    if (!machines.includes(machine)) machines.push(machine);
  }
  return machines;
}

function groupByMachine(terminals: readonly Terminal[]): Map<string | undefined, Terminal[]> {
  const groups = new Map<string | undefined, Terminal[]>();
  for (const terminal of terminals) {
    const machine = machineOf(terminal);
    const group = groups.get(machine) ?? [];
    group.push(terminal);
    groups.set(machine, group);
  }
  return groups;
}

function ensureGroup(
  groups: Map<string | undefined, MachineSpaceGroup>,
  machine: string | undefined,
): MachineSpaceGroup {
  let group = groups.get(machine);
  if (group === undefined) {
    const id = machine === undefined ? "local" : `remote:${machine}`;
    group = { id, label: machine ?? "this Mac", machine, spaces: [] };
    groups.set(machine, group);
  }
  return group;
}

function orderMachineGroups(
  groups: Map<string | undefined, MachineSpaceGroup>,
): MachineSpaceGroup[] {
  return [...groups.values()].sort((left, right) => {
    if (left.machine === undefined) return right.machine === undefined ? 0 : -1;
    if (right.machine === undefined) return 1;
    return left.machine.localeCompare(right.machine);
  });
}

function machineOf(terminal: Terminal): string | undefined {
  return machineOfAddress(terminal.address);
}

function machineOfAddress(address: string): string | undefined {
  return splitAddress(address).machine;
}

function toTerminalList(
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>,
): Terminal[] {
  return Array.isArray(terminals) ? [...terminals] : Object.values(terminals);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
