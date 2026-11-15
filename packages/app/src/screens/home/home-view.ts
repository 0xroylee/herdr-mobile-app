import type { Layout, Role, Terminal } from "@herdr-mobile/protocol";
import { deriveSpaces } from "../../model/spaces.ts";
import { type EffectiveState, mostUrgent } from "../../model/status.ts";
import type { ProjectMark, TaskProject, TaskRow } from "../../model/tasks.ts";
import type { ConnectionState } from "../../store/core.ts";

export interface HomeProject extends TaskProject {
  unchecked: number;
  mark: ProjectMark;
}

export interface HomeTile {
  kind: "needs-you" | "running" | "done";
  label: "Needs you" | "Running" | "Done";
  count: number;
}

export const newTaskLabelTone = "fg" as const;

export function homeTileGlyph(kind: HomeTile["kind"]): "!" | "activity" | "check" {
  if (kind === "needs-you") return "!";
  return kind === "running" ? "activity" : "check";
}

export function homeTileIconBackground(kind: HomeTile["kind"]): string {
  if (kind === "needs-you") return "bg-blocked";
  return kind === "running" ? "bg-working" : "bg-done";
}

export interface HomeView {
  rows: TaskRow[];
  projects: HomeProject[];
  tiles: HomeTile[];
  dimmed: boolean;
  showActions: boolean;
  actionsEnabled: boolean;
}

export interface HomeViewInput {
  rows: readonly TaskRow[];
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>;
  layout: Layout | undefined;
  query?: string;
  role: Role | undefined;
  connection: ConnectionState;
}

/** Build the searchable Home rows, smart tile counts and Herdr-ordered project summaries. */
export function deriveHomeView(input: HomeViewInput): HomeView {
  const candidates = projectCandidates(input.layout, input.terminals, input.rows);
  const openRows = input.rows.filter((row) => !row.checked && row.state !== "not-started");
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const rows =
    query.length === 0 ? openRows : openRows.filter((row) => matchesHomeSearch(row, query));
  const projectIdsWithRows = new Set(rows.map((row) => row.project.id));
  const projects = candidates
    .filter((project) => {
      const hasRows = projectIdsWithRows.has(project.id);
      if (query.length > 0) return hasRows;
      return hasRows || project.id !== "other";
    })
    .map((project) => {
      const projectRows = rows.filter((row) => row.project.id === project.id);
      const unchecked = projectRows.length;
      return { ...project, unchecked, mark: projectMark(projectRows) };
    });

  return {
    rows,
    projects,
    tiles: [
      {
        kind: "needs-you",
        label: "Needs you",
        count: rows.filter((row) => row.state === "needs-you").length,
      },
      {
        kind: "running",
        label: "Running",
        count: rows.filter((row) => row.state === "running").length,
      },
      {
        kind: "done",
        label: "Done",
        count: rows.filter((row) => row.state === "done" || row.state === "stopped").length,
      },
    ],
    dimmed: input.connection !== "connected",
    showActions: input.role === "control",
    actionsEnabled: input.role === "control" && input.connection === "connected",
  };
}

/** Search open task titles, project names and program names case-insensitively. */
export function matchesHomeSearch(row: TaskRow, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [row.title, row.project.name, row.program.name].some((value) =>
    value.toLocaleLowerCase().includes(normalized),
  );
}

function projectCandidates(
  layout: Layout | undefined,
  terminals: HomeViewInput["terminals"],
  rows: readonly TaskRow[],
): TaskProject[] {
  const projects: TaskProject[] = [];
  const knownIds = new Set<string>();
  const localSpaces = deriveSpaces(terminals, layout).flatMap((group) =>
    group.machine === undefined ? group.spaces : [],
  );

  for (const space of localSpaces) {
    const layoutSpace = layout?.spaces.find((candidate) => candidate.id === space.id);
    const matchingTask = rows.find(
      (row) => row.project.id === space.id || row.project.name === space.name,
    );
    const project: TaskProject = layoutSpace
      ? {
          id: layoutSpace.id,
          name: nonEmpty(layoutSpace.name) ?? folderName(layoutSpace.folder) ?? "Other",
          folder: layoutSpace.folder ?? undefined,
        }
      : (matchingTask?.project ?? { id: space.id, name: space.name, folder: undefined });
    if (knownIds.has(project.id)) continue;
    if (project.id === "other" && !rows.some((row) => row.project.id === project.id)) continue;
    knownIds.add(project.id);
    projects.push(project);
  }

  for (const row of rows) {
    if (knownIds.has(row.project.id)) continue;
    knownIds.add(row.project.id);
    projects.push(row.project);
  }

  return projects;
}

function projectMark(rows: readonly TaskRow[]): ProjectMark {
  if (rows.length === 0) return undefined;
  const urgent = mostUrgent(rows.map(taskUrgency));
  if (urgent === "blocked") return "needs-you";
  if (urgent === "working") return "running";
  if (urgent === "done") return "done";
  return undefined;
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

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function folderName(folder: string | null): string | undefined {
  if (folder === null) return undefined;
  const parts = folder.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts.at(-1) || undefined;
}
