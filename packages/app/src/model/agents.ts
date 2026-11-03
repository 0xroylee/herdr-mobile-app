import type { Layout, LayoutSpace, LayoutTab, Terminal } from "@herdr-mobile/protocol";
import { getProgram, type ProgramInfo } from "./program.ts";
import { isAddressSeen, type SeenState } from "./seen.ts";
import { type EffectiveState, effectiveState, mostUrgent, urgencyOrder } from "./status.ts";
import { formatAge } from "./time.ts";

export type AgentSort = "priority" | "space";
export type AgentFilter = string | ((agent: AgentRow) => boolean);

export interface AgentRow {
  address: string;
  terminal: Terminal;
  title: string;
  subtitle: string;
  question: string | undefined;
  pending: boolean;
  program: ProgramInfo;
  state: EffectiveState;
  age: string;
  status_ms: number | null | undefined;
  space: string;
  spaceId: string | undefined;
  tab: string | undefined;
  tabId: string | undefined;
}

export interface AgentSection {
  id: string;
  label: string;
  state: EffectiveState | undefined;
  agents: AgentRow[];
}

interface LayoutLocation {
  space: LayoutSpace;
  tab: LayoutTab;
}

const sectionLabels: Record<EffectiveState, string> = {
  blocked: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

/** Derive screen-ready agent sections from protocol state and local preferences. */
export function deriveAgents(
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>,
  layout: Layout | undefined,
  seen: SeenState,
  machineId: string,
  now: number,
  sort: AgentSort,
  filter: AgentFilter | undefined,
): AgentSection[] {
  const terminalList = toTerminalList(terminals);
  const locations = buildLocations(layout);
  const rows = terminalList
    .flatMap((terminal) => {
      const reported = terminal.reported === true || terminal.status != null;
      const pending = !reported && isPendingTerminal(terminal);
      if (!reported && !pending) return [];
      return [
        makeAgentRow(
          terminal,
          locations.get(terminal.address),
          layout,
          seen,
          machineId,
          now,
          sort,
          pending,
        ),
      ];
    })
    .filter((agent) => matchesFilter(agent, filter));

  return sort === "space"
    ? deriveSpaceSections(rows, terminalList, layout)
    : derivePrioritySections(rows);
}

function makeAgentRow(
  terminal: Terminal,
  location: LayoutLocation | undefined,
  layout: Layout | undefined,
  seen: SeenState,
  machineId: string,
  now: number,
  sort: AgentSort,
  pending: boolean,
): AgentRow {
  const program = getProgram(terminal);
  const labelSpace = layout === undefined ? terminal.labels["herdr.space"] : undefined;
  const labelTab = layout === undefined ? terminal.labels["herdr.tab"] : undefined;
  const knownSpace = nonEmpty(location?.space.name) ?? nonEmpty(labelSpace);
  const space = knownSpace ?? "Other";
  const tab = nonEmpty(location?.tab.name) ?? nonEmpty(labelTab);
  const title = tab ?? nonEmpty(terminal.title) ?? nonEmpty(terminal.name) ?? program.name;
  const turnSeen = isAddressSeen(seen, machineId, terminal.address, terminal.turn);
  const state = pending ? "idle" : effectiveState(terminal.status, { seen: turnSeen });
  const statusTimestamp = terminal.status_ms ?? terminal.finished_ms ?? terminal.created_ms;
  const question = pending
    ? undefined
    : (nonEmpty(terminal.status?.msg) ?? nonEmpty(terminal.status?.title));
  const subtitle =
    sort === "priority"
      ? `${space} · ${program.name}`
      : state === "blocked" && question !== undefined
        ? `${program.name} · ${question}`
        : program.name;

  return {
    address: terminal.address,
    terminal,
    title,
    subtitle,
    question,
    pending,
    program,
    state,
    age: formatAge(statusTimestamp, now),
    status_ms: terminal.status_ms,
    space,
    spaceId: location?.space.id,
    tab,
    tabId: location?.tab.id,
  };
}

function isPendingTerminal(terminal: Terminal): boolean {
  return (
    terminal.state === "live" &&
    terminal.reported !== true &&
    terminal.status == null &&
    (terminal.template != null || getProgram(terminal).iconKey !== "bot")
  );
}

function derivePrioritySections(rows: AgentRow[]): AgentSection[] {
  const sections: AgentSection[] = [];
  for (const state of urgencyOrder) {
    const agents = rows
      .filter((row) => row.state === state)
      .sort((left, right) => compareStatusTime(left, right));
    if (agents.length > 0) {
      sections.push({ id: state, label: sectionLabels[state], state, agents });
    }
  }
  return sections;
}

function deriveSpaceSections(
  rows: AgentRow[],
  terminalList: readonly Terminal[],
  layout: Layout | undefined,
): AgentSection[] {
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  const sections: AgentSection[] = [];
  const assigned = new Set<string>();

  if (layout !== undefined) {
    for (const space of layout.spaces) {
      const agents: AgentRow[] = [];
      for (const tab of space.tabs) {
        for (const address of tab.terminalAddresses) {
          const agent = byAddress.get(address);
          if (agent !== undefined && !assigned.has(address)) {
            agents.push(agent);
            assigned.add(address);
          }
        }
      }
      if (agents.length > 0) {
        sections.push({
          id: `space:${space.id}`,
          label: nonEmpty(space.name) ?? "Other",
          state: mostUrgent(agents.map(({ state }) => state)),
          agents,
        });
      }
    }
  } else {
    const labels = new Map<string, AgentRow[]>();
    for (const terminal of terminalList) {
      const agent = byAddress.get(terminal.address);
      if (agent === undefined || assigned.has(agent.address)) continue;
      const name = agent.space;
      const list = labels.get(name) ?? [];
      list.push(agent);
      labels.set(name, list);
      assigned.add(agent.address);
    }
    for (const [name, agents] of labels) {
      sections.push({
        id: `space-label:${name}`,
        label: name,
        state: mostUrgent(agents.map(({ state }) => state)),
        agents,
      });
    }
  }

  const otherAgents = rows.filter((row) => !assigned.has(row.address));
  if (otherAgents.length > 0) {
    sections.push({
      id: "space:other",
      label: "Other",
      state: mostUrgent(otherAgents.map(({ state }) => state)),
      agents: otherAgents,
    });
  }

  return sections;
}

function buildLocations(layout: Layout | undefined): Map<string, LayoutLocation> {
  const locations = new Map<string, LayoutLocation>();
  for (const space of layout?.spaces ?? []) {
    for (const tab of space.tabs) {
      for (const address of tab.terminalAddresses) {
        if (!locations.has(address)) {
          locations.set(address, { space, tab });
        }
      }
    }
  }
  return locations;
}

function matchesFilter(agent: AgentRow, filter: AgentFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "function") return filter(agent);
  const query = filter.trim().toLocaleLowerCase();
  if (query.length === 0) return true;
  return [agent.title, agent.subtitle, agent.question ?? "", agent.address].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

function compareStatusTime(left: AgentRow, right: AgentRow): number {
  const leftTime = left.status_ms ?? Number.NEGATIVE_INFINITY;
  const rightTime = right.status_ms ?? Number.NEGATIVE_INFINITY;
  return rightTime - leftTime || left.address.localeCompare(right.address);
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
