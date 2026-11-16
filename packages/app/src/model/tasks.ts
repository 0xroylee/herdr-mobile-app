import {
  isEnded,
  type Layout,
  type LayoutSpace,
  matchTerminal,
  type Status,
  stoppedText,
  type TaskRecord,
  type TaskState,
  type Terminal,
  taskState,
} from "@herdr-mobile/protocol";
import { splitAddress } from "./address.ts";
import { buildLocations, isPendingTerminal } from "./agents.ts";
import { getProgram, type ProgramInfo } from "./program.ts";
import { type EffectiveState, mostUrgent } from "./status.ts";
import { formatAge } from "./time.ts";

export type { TaskState };
export { isEnded, stoppedText, taskState };
export type ProjectMark = "needs-you" | "running" | "done" | undefined;
export type LastSeenStatuses = Readonly<Record<string, Status | null | undefined>>;
export type TaskTerminalTable = readonly Terminal[] | Readonly<Record<string, Terminal>>;

export interface TaskProject {
  id: string;
  name: string;
  folder: string | undefined;
}

export interface TaskRow {
  id: string;
  record: TaskRecord | undefined;
  address: string | undefined;
  terminal: Terminal | undefined;
  title: string;
  program: ProgramInfo;
  state: TaskState;
  createdAt: number;
  timestamp: number;
  age: string;
  project: TaskProject;
  fromHerdr: boolean;
  unlinked: boolean;
  /** True when the shared window-start matcher found the terminal for an unlinked record. */
  matched: boolean;
  checked: boolean;
  question: string | undefined;
  stoppedText: string | undefined;
}

export interface ProjectTaskCounts {
  unchecked: number;
  mark: ProjectMark;
}

export interface TaskCounts {
  needsYou: number;
  running: number;
  done: number;
  projects: Readonly<Record<string, ProjectTaskCounts>>;
}

export interface DerivedTasks {
  rows: TaskRow[];
  byProject: Readonly<Record<string, TaskRow[]>>;
  counts: TaskCounts;
  taskFor(id: string): TaskRow | undefined;
}

/** Derive task rows and list counts from one machine's document and terminal snapshot. */
export function deriveTasks(
  records: Readonly<Record<string, TaskRecord>>,
  terminals: TaskTerminalTable,
  layout: Layout | undefined,
  lastSeen: LastSeenStatuses,
  now: number,
): DerivedTasks {
  const terminalList = toTerminalList(terminals).filter(isLocalTerminal);
  const byAddress = new Map(terminalList.map((terminal) => [terminal.address, terminal]));
  const locations = buildLocations(layout);
  const spacesById = new Map((layout?.spaces ?? []).map((space) => [space.id, space]));
  const taskRecords = Object.values(records).sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
  const claimed = new Set(
    taskRecords.flatMap((record) => (record.terminal === undefined ? [] : [record.terminal])),
  );
  const rows: TaskRow[] = [];

  for (const record of taskRecords) {
    let address = record.terminal;
    let terminal = address === undefined ? undefined : byAddress.get(address);
    let matched = false;

    if (address === undefined && record.run?.kind === "program" && record.folder !== undefined) {
      const match = matchTerminal(
        terminalList.filter((candidate) => !claimed.has(candidate.address)),
        {
          program: record.run.id,
          folder: record.folder,
          ...(record.space === undefined ? {} : { spaceId: record.space.id }),
        },
        record.createdAt,
      );
      if (match !== undefined) {
        address = match.address;
        terminal = match;
        matched = true;
      }
    }

    if (address !== undefined && splitAddress(address).machine !== undefined) continue;
    if (address !== undefined) claimed.add(address);

    const location = address === undefined ? undefined : locations.get(address);
    const recordSpace = record.space === undefined ? undefined : spacesById.get(record.space.id);
    const labelSpaceId = terminal?.labels["herdr.space"];
    const labelSpace = labelSpaceId === undefined ? undefined : spacesById.get(labelSpaceId);
    const project = makeProject(
      location?.space ?? recordSpace ?? labelSpace,
      location?.space === undefined && recordSpace === undefined
        ? (labelSpaceId ?? terminal?.labels["herdr.space"])
        : undefined,
    );
    const createdAt = record.createdAt;
    const timestamp =
      terminal?.status_ms ?? terminal?.finished_ms ?? terminal?.created_ms ?? createdAt;
    const program = terminal === undefined ? programForRecord(record) : getProgram(terminal);
    const title = taskTitle(
      record,
      terminal,
      program,
      location?.tab.name,
      layout === undefined ? terminal?.labels["herdr.tab"] : undefined,
    );
    const state = taskState(record, terminal, lastSeen[address ?? ""]);
    const question =
      state === "needs-you"
        ? (nonEmpty(terminal?.status?.msg) ?? nonEmpty(terminal?.status?.title))
        : undefined;

    rows.push({
      id: record.id,
      record,
      address,
      terminal,
      title,
      program,
      state,
      createdAt,
      timestamp,
      age: formatAge(timestamp, now),
      project,
      fromHerdr: record.origin === "herdr",
      unlinked: record.terminal === undefined && terminal === undefined,
      matched,
      checked: state === "checked",
      question,
      stoppedText: state === "stopped" ? stoppedText(terminal) : undefined,
    });
  }

  for (const terminal of terminalList) {
    if (claimed.has(terminal.address)) continue;
    if (terminal.state === "finished") continue;
    const reported = terminal.reported === true || terminal.status != null;
    if (!reported && !isPendingTerminal(terminal)) continue;

    const location = locations.get(terminal.address);
    const labelSpaceId = terminal.labels["herdr.space"];
    const labelSpace = labelSpaceId === undefined ? undefined : spacesById.get(labelSpaceId);
    const project = makeProject(
      location?.space ?? labelSpace,
      location?.space === undefined ? (labelSpaceId ?? undefined) : undefined,
    );
    const program = getProgram(terminal);
    const state = taskState(undefined, terminal, lastSeen[terminal.address]);
    const timestamp = terminal.status_ms ?? terminal.finished_ms ?? terminal.created_ms;

    rows.push({
      id: `t:${terminal.address}`,
      record: undefined,
      address: terminal.address,
      terminal,
      title: agentTitle(
        terminal,
        program,
        location?.tab.name,
        layout === undefined ? terminal.labels["herdr.tab"] : undefined,
      ),
      program,
      state,
      createdAt: terminal.created_ms,
      timestamp,
      age: formatAge(timestamp, now),
      project,
      fromHerdr: true,
      unlinked: false,
      matched: false,
      checked: false,
      question:
        state === "needs-you"
          ? (nonEmpty(terminal.status?.msg) ?? nonEmpty(terminal.status?.title))
          : undefined,
      stoppedText: state === "stopped" ? stoppedText(terminal) : undefined,
    });
    claimed.add(terminal.address);
  }

  rows.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.terminal?.created_ms ?? left.createdAt) -
        (right.terminal?.created_ms ?? right.createdAt) ||
      left.id.localeCompare(right.id),
  );

  const projectRowsById = new Map<string, TaskRow[]>();
  for (const row of rows) {
    const projectRows = projectRowsById.get(row.project.id) ?? [];
    projectRows.push(row);
    projectRowsById.set(row.project.id, projectRows);
  }

  const projectCountsById = new Map<string, ProjectTaskCounts>();
  for (const [projectId, projectRows] of projectRowsById) {
    const unchecked = projectRows.filter((row) => !row.checked);
    const urgent = mostUrgent(unchecked.map(taskUrgency));
    projectCountsById.set(projectId, {
      unchecked: unchecked.length,
      mark:
        urgent === "blocked"
          ? "needs-you"
          : urgent === "working"
            ? "running"
            : urgent === "done"
              ? "done"
              : undefined,
    });
  }

  const byProject: Record<string, TaskRow[]> = Object.fromEntries(projectRowsById);
  const projects: Record<string, ProjectTaskCounts> = Object.fromEntries(projectCountsById);
  const unchecked = rows.filter((row) => !row.checked);
  const counts: TaskCounts = {
    needsYou: unchecked.filter((row) => row.state === "needs-you").length,
    running: unchecked.filter((row) => row.state === "running").length,
    done: unchecked.filter((row) => row.state === "done" || row.state === "stopped").length,
    projects,
  };
  const byId = new Map(rows.map((row) => [row.id, row]));

  return {
    rows,
    byProject,
    counts,
    taskFor: (id) => byId.get(id),
  };
}

function makeProject(space: LayoutSpace | undefined, fallbackId: string | undefined): TaskProject {
  if (space === undefined)
    return { id: fallbackId ?? "other", name: fallbackId ?? "Other", folder: undefined };
  const folder = space.folder ?? undefined;
  return {
    id: space.id,
    name: nonEmpty(space.name) ?? (folder === undefined ? "Other" : basename(folder)),
    folder,
  };
}

function programForRecord(record: TaskRecord): ProgramInfo {
  if (record.run?.kind === "program") {
    return getProgram({ argv: [record.run.id], status: null });
  }
  if (record.run?.kind === "template") return { name: record.run.name, iconKey: "bot" };
  return { name: "Terminal", iconKey: "bot" };
}

function taskTitle(
  record: TaskRecord,
  terminal: Terminal | undefined,
  program: ProgramInfo,
  tabName: string | undefined,
  labelTabName: string | undefined,
): string {
  const title = record.text?.split(/\r?\n/, 1)[0];
  return nonEmpty(title) ?? agentTitle(terminal, program, tabName, labelTabName);
}

function agentTitle(
  terminal: Terminal | undefined,
  program: ProgramInfo,
  tabName: string | undefined,
  labelTabName: string | undefined,
): string {
  return (
    nonEmpty(tabName) ??
    nonEmpty(labelTabName) ??
    nonEmpty(terminal?.title) ??
    nonEmpty(terminal?.name) ??
    program.name
  );
}

function taskUrgency(row: TaskRow): EffectiveState {
  switch (row.state) {
    case "needs-you":
      return "blocked";
    case "done":
    case "stopped":
      return "done";
    case "running":
      return "working";
    case "checked":
    case "not-started":
      return "idle";
  }
}

function isLocalTerminal(terminal: Terminal): boolean {
  return splitAddress(terminal.address).machine === undefined;
}

function toTerminalList(terminals: TaskTerminalTable): Terminal[] {
  return Array.isArray(terminals) ? [...terminals] : Object.values(terminals);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) + 1);
}
