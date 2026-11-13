import type { AgentFilter, AgentRow, AgentSection, AgentSort } from "../../model/agents.ts";
import { deriveAgents } from "../../model/agents.ts";
import type { SeenState } from "../../model/seen.ts";
import type { ConnectionState, MachineCoreState } from "../../store/core.ts";
import type { Machine } from "../../store/machines.ts";

export interface AgentSearchFields {
  title: string;
  space: string;
  program: { name: string };
}

export interface ActiveAgentMachine {
  machine: Machine | undefined;
  core: MachineCoreState;
}

export interface AgentSections {
  sections: AgentSection[];
  allSections: AgentSection[];
  spaceSections: AgentSection[];
}

export type AgentListEntry =
  | { kind: "header"; key: string; section: AgentSection }
  | {
      kind: "row";
      key: string;
      agent: AgentRow;
      section: AgentSection;
      position: "only" | "first" | "middle" | "last";
    };

export type ConnectionBanner =
  | { kind: "reconnecting"; message: string; action: "none" }
  | { kind: "offline"; message: string; action: "retry" }
  | { kind: "unauthorized"; message: string; action: "pair" };

export interface ConnectionPresentation {
  dimCachedRows: boolean;
  banner: ConnectionBanner | undefined;
}

/** Match only the fields the Agents search is meant to cover. */
export function matchesAgentSearch(agent: AgentSearchFields, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return true;
  return [agent.title, agent.space, agent.program.name].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

/** Adapt the screen search to deriveAgents without broadening its search fields. */
export function agentSearchFilter(query: string): AgentFilter | undefined {
  return query.trim().length === 0
    ? undefined
    : (agent: AgentRow) => matchesAgentSearch(agent, query);
}

export function countAgents(sections: readonly AgentSection[]): number {
  return sections.reduce((count, section) => count + section.agents.length, 0);
}

/** Find the row selected by the long-press menu without flattening screen state in JSX. */
export function findAgent(
  sections: readonly AgentSection[],
  address: string | undefined,
): AgentRow | undefined {
  if (address === undefined) return undefined;
  return sections.flatMap((section) => section.agents).find((agent) => agent.address === address);
}

/** Select the paired machine and its retained core snapshot from the store records. */
export function selectActiveAgentMachine(
  activeId: string | null,
  machines: Readonly<Record<string, Machine>>,
  cores: Readonly<Record<string, MachineCoreState>>,
  emptyCore: MachineCoreState,
): ActiveAgentMachine {
  return {
    machine: activeId === null ? undefined : machines[activeId],
    core: activeId === null ? emptyCore : (cores[activeId] ?? emptyCore),
  };
}

/** Derive filtered and unfiltered rows with U7's model and the active machine's seen scope. */
export function deriveAgentSections(
  activeId: string | null,
  core: MachineCoreState,
  seen: SeenState,
  now: number,
  sort: AgentSort,
  filter: AgentFilter | undefined,
): AgentSections {
  const machineId = activeId ?? "";
  return {
    sections: deriveAgents(core.terminals, core.layout, seen, machineId, now, sort, filter),
    allSections: deriveAgents(core.terminals, core.layout, seen, machineId, now, sort, undefined),
    spaceSections: deriveAgents(
      core.terminals,
      core.layout,
      seen,
      machineId,
      now,
      "space",
      undefined,
    ),
  };
}

/** Persist the next sort choice through the settings store. */
export function toggleAgentSort(current: AgentSort, save: (sort: AgentSort) => void): AgentSort {
  const next = current === "priority" ? "space" : "priority";
  save(next);
  return next;
}

/** Refresh display ages every 30 seconds and return the effect cleanup. */
export function startAgentAgeRefresh(
  onRefresh: () => void,
  schedule: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setInterval> = setInterval,
  cancel: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): () => void {
  const timer = schedule(onRefresh, 30_000);
  return () => cancel(timer);
}

/** Only priority rows get a separate question callout; by-space subtitles already include it. */
export function blockedQuestionCallout(
  sort: AgentSort,
  state: AgentRow["state"],
  question: string | undefined,
): string | undefined {
  return sort === "priority" && state === "blocked" ? question : undefined;
}

/** Flatten sections so FlashList virtualizes each header and agent row independently. */
export function flattenAgentSections(sections: readonly AgentSection[]): AgentListEntry[] {
  const entries: AgentListEntry[] = [];
  for (const section of sections) {
    entries.push({ kind: "header", key: `header:${section.id}`, section });
    section.agents.forEach((agent, index) => {
      const position =
        section.agents.length === 1
          ? "only"
          : index === 0
            ? "first"
            : index === section.agents.length - 1
              ? "last"
              : "middle";
      entries.push({
        kind: "row",
        key: `row:${section.id}:${agent.address}`,
        agent,
        section,
        position,
      });
    });
  }
  return entries;
}

/** Describe connection copy, stale-row dimming, and the available recovery action. */
export function connectionPresentation(
  state: ConnectionState,
  hasCachedRows: boolean,
  machineName: string | undefined,
): ConnectionPresentation {
  const dimCachedRows = state !== "connected" && hasCachedRows;
  if (state === "connected" || machineName === undefined) {
    return { dimCachedRows, banner: undefined };
  }

  switch (state) {
    case "connecting":
      return {
        dimCachedRows,
        banner: {
          kind: "reconnecting",
          message: `${hasCachedRows ? "Reconnecting" : "Connecting"} to ${machineName}…`,
          action: "none",
        },
      };
    case "reconnecting":
      return {
        dimCachedRows,
        banner: {
          kind: "reconnecting",
          message: `Reconnecting to ${machineName}…`,
          action: "none",
        },
      };
    case "offline":
      return {
        dimCachedRows,
        banner: {
          kind: "offline",
          message: "Can't reach the bridge. Check that Tailscale is on.",
          action: "retry",
        },
      };
    case "unauthorized":
      return {
        dimCachedRows,
        banner: {
          kind: "unauthorized",
          message: `This device is no longer paired with ${machineName}.`,
          action: "pair",
        },
      };
    case "identity_changed":
      return {
        dimCachedRows,
        banner: {
          kind: "unauthorized",
          message: "This Mac's bridge identity changed. Pair again.",
          action: "pair",
        },
      };
  }
}
