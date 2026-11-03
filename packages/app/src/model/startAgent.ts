import type {
  AgentCatalog,
  Layout,
  Role,
  StartAgentPlacement,
  StartAgentRequest,
  StartAgentRun,
  StartAgentSpace,
  Terminal,
} from "@herdr-mobile/protocol";
import { deriveSpaces, type SpaceRow } from "./spaces.ts";

export const NEW_SPACE_KEY = "new";

export type StartRunSelection = StartAgentRun | { kind: "empty" };

export interface StartRunChoice {
  key: string;
  kind: "program" | "template" | "empty";
  selection: StartRunSelection;
  name: string;
  description: string;
  program?: string;
}

export interface StartSpaceChoice {
  selection: StartAgentSpace;
  displayId?: string;
  name: string;
  folder?: string;
}

export type StartSpaceTargetResolver = (
  row: SpaceRow,
  layout: Layout | undefined,
) => string | undefined;

export interface FolderSuggestion {
  path: string;
  source: "space" | "terminal" | "recent";
}

export interface StartOptions {
  runChoices: StartRunChoice[];
  spaceChoices: StartSpaceChoice[];
  foldersBySpace: Record<string, FolderSuggestion[]>;
}

export interface StartDraft {
  run: StartRunSelection | undefined;
  folder: string;
  space: StartAgentSpace | undefined;
  task: string;
}

export function canShowStartEntryPoint(role: Role | undefined): boolean {
  return role === "control";
}

export function canStartNow(role: Role | undefined, connected: boolean): boolean {
  return canShowStartEntryPoint(role) && connected;
}

export interface StartFieldErrors {
  run?: string;
  folder?: string;
  space?: string;
}

export type StartDraftValidation =
  | { ok: true; request: StartAgentRequest }
  | { ok: false; errors: StartFieldErrors };

/** Build the safe run choices and folder suggestions available on the active machine. */
export function deriveStartOptions(
  catalog: AgentCatalog | undefined,
  layout: Layout | undefined,
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>,
  recentFolders: readonly string[],
  preselectedSpaceId: string | undefined,
  resolveTarget: StartSpaceTargetResolver,
): StartOptions {
  const terminalList = toTerminalList(terminals);
  const terminalByAddress = new Map(terminalList.map((terminal) => [terminal.address, terminal]));
  const derivedRows = deriveSpaces(terminalList, layout).flatMap((group) => group.spaces);
  const rowById = new Map(derivedRows.map((row) => [row.id, row]));
  const spaceChoices: StartSpaceChoice[] = [];
  const foldersBySpace: Record<string, FolderSuggestion[]> = {};
  const seenDisplayIds = new Set<string>();
  const seenTargetIds = new Set<string>();

  for (const space of layout?.spaces ?? []) {
    if (seenDisplayIds.has(space.id)) continue;
    const row = rowById.get(space.id);
    if (!row) continue;
    const target = resolveTarget(row, layout);
    if (!target || seenTargetIds.has(target)) continue;
    seenDisplayIds.add(space.id);
    seenTargetIds.add(target);
    const folder = nonEmpty(space.folder ?? undefined);
    spaceChoices.push({
      selection: { kind: "existing", id: target },
      displayId: row.id,
      name: nonEmpty(space.name) ?? "Other",
      ...(folder ? { folder } : {}),
    });
    foldersBySpace[target] = buildFolderSuggestions(
      folder,
      terminalsForSpace(
        row,
        space.tabs.flatMap((tab) => tab.terminalAddresses),
        terminalByAddress,
      ),
      recentFolders,
    );
  }

  for (const row of derivedRows) {
    if (seenDisplayIds.has(row.id)) continue;
    const target = resolveTarget(row, layout);
    if (!target || seenTargetIds.has(target)) continue;
    seenDisplayIds.add(row.id);
    seenTargetIds.add(target);
    spaceChoices.push({
      selection: { kind: "existing", id: target },
      displayId: row.id,
      name: row.name,
    });
    foldersBySpace[target] = buildFolderSuggestions(
      undefined,
      terminalsForSpace(row, [], terminalByAddress),
      recentFolders,
    );
  }

  spaceChoices.push({ selection: { kind: "new" }, name: "New space" });
  foldersBySpace[NEW_SPACE_KEY] = buildFolderSuggestions(undefined, [], recentFolders);

  const runChoices = catalog
    ? catalog.programs.map((program) => program.trim()).filter(Boolean)
    : ["claude", "codex"];
  const uniquePrograms = [...new Set(runChoices)];
  const choices: StartRunChoice[] = uniquePrograms.map((program) => ({
    key: `program:${program}`,
    kind: "program",
    selection: { kind: "program", id: program },
    name: programDisplayName(program),
    description: "Interactive session",
    program,
  }));

  for (const template of catalog?.templates ?? []) {
    const name = template.name.trim();
    if (!name) continue;
    choices.push({
      key: `template:${name}`,
      kind: "template",
      selection: { kind: "template", name },
      name,
      description: template.description,
      program: name,
    });
  }

  if (preselectedSpaceId && seenDisplayIds.has(preselectedSpaceId)) {
    choices.push({
      key: "empty",
      kind: "empty",
      selection: { kind: "empty" },
      name: "Empty tab",
      description: "Create a blank terminal tab",
    });
  }

  return { runChoices: choices, spaceChoices, foldersBySpace };
}

/** Find the display row that corresponds to a placement id returned by the bridge. */
export function findSpaceForTarget(
  targetId: string,
  spaces: readonly SpaceRow[],
  layout: Layout | undefined,
  resolveTarget: StartSpaceTargetResolver,
): SpaceRow | undefined {
  return spaces.find((space) => resolveTarget(space, layout) === targetId);
}

export function firstMessageNeedsWindow(
  catalog: AgentCatalog | undefined,
  run: StartRunSelection | undefined,
): boolean {
  return catalog?.windowOpen === false && run?.kind === "program";
}

export function startPlacementNotice(placement: StartAgentPlacement): string {
  return placement === "core"
    ? "Started in herdr-core. Herdr shows it when it opens."
    : "Started in Herdr.";
}

/** Validate a draft before it becomes the bridge's constrained start request. */
export function validateStartDraft(draft: StartDraft): StartDraftValidation {
  const errors: StartFieldErrors = {};
  const run = normalizeRun(draft.run);
  const folder = draft.folder.trim();
  const space = normalizeSpace(draft.space);

  if (run === undefined) errors.run = "Choose a program or template.";
  if (!isAllowedFolderSyntax(folder)) {
    errors.folder =
      folder.length === 0
        ? "Choose a folder."
        : "Enter an absolute path or a path starting with ~/.";
  }
  if (space === undefined) errors.space = "Choose a space.";
  if (Object.keys(errors).length > 0 || run === undefined || space === undefined) {
    return { ok: false, errors };
  }

  const task = draft.task.trim();
  return {
    ok: true,
    request: {
      run,
      folder,
      space,
      ...(task.length > 0 ? { task } : {}),
    },
  };
}

export function startSpaceKey(space: StartAgentSpace | undefined): string | undefined {
  if (!space) return undefined;
  return space.kind === "existing" ? space.id : NEW_SPACE_KEY;
}

function normalizeRun(run: StartRunSelection | undefined): StartAgentRun | undefined {
  if (!run || run.kind === "empty") return undefined;
  if (run.kind === "program") {
    const id = run.id.trim();
    return id.length > 0 ? { kind: "program", id } : undefined;
  }
  if (run.kind === "template") {
    const name = run.name.trim();
    return name.length > 0 ? { kind: "template", name } : undefined;
  }
  return undefined;
}

function normalizeSpace(space: StartAgentSpace | undefined): StartAgentSpace | undefined {
  if (!space) return undefined;
  if (space.kind === "existing") {
    const id = space.id.trim();
    return id.length > 0 ? { kind: "existing", id } : undefined;
  }
  if (space.kind === "new") {
    const name = space.name?.trim();
    return { kind: "new", ...(name ? { name } : {}) };
  }
  return undefined;
}

function isAllowedFolderSyntax(folder: string): boolean {
  return folder.startsWith("/") || folder.startsWith("~/");
}

function buildFolderSuggestions(
  spaceFolder: string | undefined,
  terminals: readonly Terminal[],
  recentFolders: readonly string[],
): FolderSuggestion[] {
  const suggestions: FolderSuggestion[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined, source: FolderSuggestion["source"]) => {
    const normalized = nonEmpty(path);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    suggestions.push({ path: normalized, source });
  };

  add(spaceFolder, "space");
  for (const terminal of terminals) add(terminal.cwd, "terminal");
  for (const folder of recentFolders.slice(0, 5)) add(folder, "recent");
  return suggestions;
}

function terminalsForSpace(
  row: SpaceRow | undefined,
  addresses: readonly string[],
  byAddress: ReadonlyMap<string, Terminal>,
): Terminal[] {
  if (addresses.length > 0) {
    return addresses
      .map((address) => byAddress.get(address))
      .filter((terminal): terminal is Terminal => terminal !== undefined);
  }
  return row?.tabs.flatMap((tab) => tab.terminals) ?? [];
}

function toTerminalList(
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>,
): Terminal[] {
  return Array.isArray(terminals) ? [...terminals] : Object.values(terminals);
}

function programDisplayName(program: string): string {
  if (program.toLowerCase() === "claude") return "Claude Code";
  if (program.toLowerCase() === "codex") return "Codex";
  return program.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
