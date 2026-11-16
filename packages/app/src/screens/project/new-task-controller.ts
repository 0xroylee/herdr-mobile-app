import type {
  AgentCatalog,
  Layout,
  Role,
  StartAgentRun,
  StartAgentSpace,
  StartTaskReply,
  StartTaskRequest,
  TaskRecord,
  Terminal,
} from "@herdr-mobile/protocol";
import {
  deriveStartOptions,
  type FolderSuggestion,
  type StartFieldErrors,
  type StartOptions,
  type StartRunSelection,
  type StartSpaceChoice,
  startSpaceKey,
  validateStartDraft,
} from "../../model/startAgent.ts";
import { BridgeApiError } from "../../net/bridge-api.ts";
import { projectTaskId } from "./viewState.ts";

export interface NewTaskDraft {
  text: string;
  notes: string;
  run: StartAgentRun | undefined;
  folder: string;
  project: StartAgentSpace | undefined;
}

export interface NewTaskSeed extends Partial<NewTaskDraft> {}

export interface NewTaskContext {
  machineId: string | undefined;
  role: Role | undefined;
  connected: boolean;
  layout: Layout | undefined;
  terminals: readonly Terminal[] | Readonly<Record<string, Terminal>>;
  recentFolders: readonly string[];
  lastRun: StartAgentRun | undefined;
}

export interface NewTaskPort {
  catalog(): Promise<AgentCatalog>;
  start(request: StartTaskRequest): Promise<StartTaskReply>;
  rememberRun(machineId: string, run: StartAgentRun): void;
  rememberFolder(machineId: string, folder: string): void;
}

export interface NewTaskControllerState {
  status: "loading" | "editing" | "starting";
  loadingCatalog: boolean;
  catalog?: AgentCatalog;
  catalogError?: string;
  refreshAvailable: boolean;
  error?: string;
  errorCode?: string;
  fieldErrors?: StartFieldErrors & { task?: string };
  folderPickerRequest: number;
  options: StartOptions;
  draft: NewTaskDraft;
  optimisticRecords: TaskRecord[];
}

export type NewTaskGoResult = "empty" | "unavailable" | "invalid" | "failed" | "started";

const emptyOptions = deriveStartOptions(undefined, undefined, [], [], undefined);
const defaultDraft: NewTaskDraft = {
  text: "",
  notes: "",
  run: undefined,
  folder: "",
  project: undefined,
};

/** Holds the task draft across the inline composer and its details route. */
export class NewTaskController {
  private snapshot: NewTaskControllerState;
  private readonly listeners = new Set<() => void>();
  private port: NewTaskPort;
  private context: NewTaskContext;
  private lastStartedSpaceIdValue: string | undefined = undefined;
  private loading = false;
  private userSetFolder = false;
  private userChoseRun = false;

  constructor(port: NewTaskPort, context: NewTaskContext, seed: NewTaskSeed = {}) {
    this.port = port;
    this.context = context;
    const draft: NewTaskDraft = { ...defaultDraft, ...seed };
    this.userSetFolder = Boolean(seed.folder);
    this.userChoseRun = seed.run !== undefined;
    this.snapshot = {
      status: "loading",
      loadingCatalog: false,
      refreshAvailable: false,
      folderPickerRequest: 0,
      options: emptyOptions,
      draft,
      optimisticRecords: [],
    };
    this.reconcileOptions();
  }

  get state(): NewTaskControllerState {
    return this.snapshot;
  }

  get lastStartedSpaceId(): string | undefined {
    return this.lastStartedSpaceIdValue;
  }

  getSnapshot = (): NewTaskControllerState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Rebind requests when the active Mac's connection manager is replaced. */
  setPort(port: NewTaskPort): void {
    this.port = port;
  }

  setContext(context: NewTaskContext): void {
    this.context = context;
    this.reconcileOptions();
  }

  setText(text: string): void {
    this.updateDraft({ text }, "task");
  }

  setNotes(notes: string): void {
    this.updateDraft({ notes }, "task");
  }

  setRun(run: StartRunSelection): void {
    if (run.kind === "empty") return;
    this.userChoseRun = true;
    this.updateDraft({ run }, "run");
  }

  setFolder(folder: string): void {
    this.userSetFolder = true;
    this.updateDraft({ folder }, "folder");
  }

  setProject(project: StartAgentSpace): void {
    this.userSetFolder = false;
    const draft = this.snapshot.draft;
    const folder = this.firstSuggestedFolder(project);
    this.updateDraft(
      {
        project,
        folder,
      },
      "space",
      ...(folder === draft.folder ? [] : ["folder" as const]),
    );
  }

  setProjectName(name: string): void {
    const project = this.snapshot.draft.project;
    if (project?.kind !== "new") return;
    this.updateDraft({ project: { kind: "new", ...(name.length > 0 ? { name } : {}) } }, "space");
  }

  async load(): Promise<void> {
    if (this.loading || this.snapshot.status === "starting") return;
    this.loading = true;
    const isInitial = this.snapshot.status === "loading" && !this.snapshot.catalog;
    this.setSnapshot({
      ...this.snapshot,
      status: isInitial ? "loading" : "editing",
      loadingCatalog: true,
      error: undefined,
      errorCode: undefined,
      refreshAvailable: false,
    });
    try {
      const catalog = await this.port.catalog();
      const { catalogError: _catalogError, ...state } = this.snapshot;
      this.setSnapshot({
        ...state,
        status: "editing",
        loadingCatalog: false,
        catalog,
        ...(catalog.templatesError ? { catalogError: catalog.templatesError } : {}),
        refreshAvailable: false,
      });
      this.reconcileOptions();
    } catch (cause) {
      const message = errorMessage(
        cause,
        "Couldn't load agent options. Built-in programs are available.",
      );
      this.setSnapshot({
        ...this.snapshot,
        status: "editing",
        loadingCatalog: false,
        catalog: undefined,
        catalogError: message,
        refreshAvailable: false,
      });
      this.reconcileOptions();
    } finally {
      this.loading = false;
    }
  }

  async go(): Promise<NewTaskGoResult> {
    if (this.snapshot.status === "starting" || this.snapshot.loadingCatalog) return "unavailable";
    const title = this.snapshot.draft.text.trim();
    if (title.length === 0) return "empty";

    if (this.context.role !== "control") return "unavailable";
    if (!this.context.connected) {
      this.setSnapshot({
        ...this.snapshot,
        status: "editing",
        error: "Can’t reach your Mac.",
        errorCode: undefined,
        refreshAvailable: false,
      });
      return "unavailable";
    }

    const task = buildTaskText(title, this.snapshot.draft.notes);
    const validation = validateStartDraft({
      run: this.snapshot.draft.run,
      folder: this.snapshot.draft.folder,
      space: this.snapshot.draft.project,
      task,
    });
    const runVisible = this.snapshot.options.runChoices.some((choice) =>
      sameRunSelection(choice.selection, this.snapshot.draft.run),
    );
    const projectVisible = projectSelectionAvailable(
      this.snapshot.draft.project,
      this.snapshot.options.spaceChoices,
      this.context.layout,
    );
    const projectUnavailable = this.snapshot.draft.project !== undefined && !projectVisible;
    if (!validation.ok || !runVisible || projectUnavailable) {
      const errors: StartFieldErrors & { task?: string } = validation.ok
        ? {}
        : { ...validation.errors };
      if (!runVisible) errors.run = "Choose a program or template.";
      if (projectUnavailable) errors.space = "This project isn’t available.";
      this.setSnapshot({
        ...this.snapshot,
        status: "editing",
        error: projectUnavailable ? "This project isn’t available." : undefined,
        errorCode: undefined,
        refreshAvailable: false,
        fieldErrors: errors,
      });
      return "invalid";
    }

    if (runNeedsHerdrOpen(this.snapshot.catalog, this.snapshot.draft.run)) {
      const message = closedWindowRunMessage(this.snapshot.draft.run);
      this.setSnapshot({
        ...this.snapshot,
        status: "editing",
        error: message,
        errorCode: "run_not_allowed",
        refreshAvailable: true,
        fieldErrors: { ...this.snapshot.fieldErrors, run: message },
      });
      return "failed";
    }

    const request: StartTaskRequest = {
      text: validation.request.task ?? task,
      run: validation.request.run,
      folder: validation.request.folder,
      space: validation.request.space,
    };
    const { catalog, catalogError, options, draft, folderPickerRequest } = this.snapshot;
    this.lastStartedSpaceIdValue = undefined;
    this.setSnapshot({
      status: "starting",
      loadingCatalog: false,
      ...(catalog ? { catalog } : {}),
      ...(catalogError ? { catalogError } : {}),
      refreshAvailable: false,
      folderPickerRequest,
      options,
      draft,
      optimisticRecords: this.snapshot.optimisticRecords,
    });

    try {
      const reply = await this.port.start(request);
      this.lastStartedSpaceIdValue = reply.start.space.id;
      if (this.context.machineId) {
        try {
          this.port.rememberRun(this.context.machineId, request.run);
          this.port.rememberFolder(this.context.machineId, request.folder);
        } catch {
          // Persistence is a convenience and cannot undo an accepted start.
        }
      }
      this.userSetFolder = Boolean(request.folder);
      this.setSnapshot({
        status: "editing",
        loadingCatalog: false,
        ...(catalog ? { catalog } : {}),
        ...(catalogError ? { catalogError } : {}),
        refreshAvailable: false,
        folderPickerRequest,
        options,
        draft: { ...draft, text: "", notes: "" },
        optimisticRecords: addPendingRecord(this.snapshot.optimisticRecords, reply.record),
      });
      return "started";
    } catch (cause) {
      const failure = startFailure(cause);
      const shouldOpenFolderPicker = failure.field === "folder";
      this.setSnapshot({
        status: "editing",
        loadingCatalog: false,
        ...(catalog ? { catalog } : {}),
        ...(catalogError ? { catalogError } : {}),
        error: failure.message,
        ...(failure.code ? { errorCode: failure.code } : {}),
        refreshAvailable: failure.refresh,
        ...(failure.field ? { fieldErrors: { [failure.field]: failure.message } } : {}),
        folderPickerRequest: folderPickerRequest + (shouldOpenFolderPicker ? 1 : 0),
        options,
        draft,
        optimisticRecords: this.snapshot.optimisticRecords,
      });
      return "failed";
    }
  }

  /** Keep accepted replies visible until the document delivers each record. */
  reconcileTasks(
    records: Readonly<Record<string, TaskRecord>>,
    observedPending: readonly TaskRecord[] = this.snapshot.optimisticRecords,
  ): void {
    const candidates = new Map(
      this.snapshot.optimisticRecords.map((record) => [record.id, record]),
    );
    for (const record of observedPending) candidates.set(record.id, record);
    const optimisticRecords = [...candidates.values()].filter(
      (record) => !Object.hasOwn(records, record.id),
    );
    if (!samePendingRecords(optimisticRecords, this.snapshot.optimisticRecords)) {
      this.setSnapshot({ ...this.snapshot, optimisticRecords });
    }
  }

  private updateDraft(
    changes: Partial<NewTaskDraft>,
    ...fields: (keyof (StartFieldErrors & { task?: string }))[]
  ): void {
    if (this.snapshot.status === "starting") return;
    const { fieldErrors, ...state } = this.snapshot;
    const remainingErrors = { ...fieldErrors };
    for (const field of fields) delete remainingErrors[field];
    this.setSnapshot({
      ...state,
      status: "editing",
      error: undefined,
      errorCode: undefined,
      refreshAvailable: false,
      ...(Object.keys(remainingErrors).length > 0 ? { fieldErrors: remainingErrors } : {}),
      draft: { ...this.snapshot.draft, ...changes },
    });
  }

  private reconcileOptions(): void {
    const options = deriveStartOptions(
      this.snapshot?.catalog,
      this.context.layout,
      this.context.terminals,
      this.context.recentFolders,
    );
    const draft = this.snapshot?.draft ?? defaultDraft;
    const selectableRuns = options.runChoices.flatMap((choice) =>
      choice.selection.kind === "empty" ? [] : [choice.selection],
    );
    const currentRun = selectableRuns.find((run) => sameRunSelection(run, draft.run));
    const lastRun = selectableRuns.find((run) => sameRunSelection(run, this.context.lastRun));
    const run = this.userChoseRun
      ? (currentRun ?? lastRun ?? selectableRuns[0])
      : (lastRun ?? currentRun ?? selectableRuns[0]);

    const currentProject = findProjectChoice(
      draft.project,
      options.spaceChoices,
      this.context.layout,
    );
    const spaceChoices = options.spaceChoices.filter(
      (choice) => choice.selection.kind === "existing",
    );
    const firstProject = spaceChoices[0];
    const project = currentProject
      ? projectSelectionForChoice(currentProject, draft.project)
      : (draft.project ?? firstProject?.selection);
    const projectChanged = !sameProjectSelection(project, draft.project);
    const folder = this.userSetFolder
      ? draft.folder
      : projectChanged || draft.folder.length === 0
        ? this.firstSuggestedFolder(project, options)
        : draft.folder;

    const { fieldErrors, ...state } = this.snapshot;
    const remainingErrors = { ...fieldErrors };
    if (run !== draft.run) delete remainingErrors.run;
    if (project !== draft.project) delete remainingErrors.space;
    if (currentProject && remainingErrors.space === "This project isn’t available.") {
      delete remainingErrors.space;
    }
    if (folder !== draft.folder) delete remainingErrors.folder;
    this.setSnapshot({
      ...state,
      ...(currentProject && state.error === "This project isn’t available."
        ? { error: undefined }
        : {}),
      options,
      ...(Object.keys(remainingErrors).length > 0 ? { fieldErrors: remainingErrors } : {}),
      draft: { ...draft, run, project, folder },
    });
  }

  private firstSuggestedFolder(
    project: StartAgentSpace | undefined,
    options: StartOptions = this.snapshot.options,
  ): string {
    const key = startSpaceKey(project) ?? "";
    const folders: readonly FolderSuggestion[] = options.foldersBySpace[key] ?? [];
    return folders[0]?.path ?? "";
  }

  private setSnapshot(snapshot: NewTaskControllerState): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

const controllerRegistry = new Map<string, NewTaskController>();

export function newTaskControllerKey(machineId: string, projectId: string): string {
  return `${machineId}:${projectId}`;
}

export function getNewTaskController(
  key: string,
  create: () => NewTaskController,
): NewTaskController {
  const existing = controllerRegistry.get(key);
  if (existing) return existing;
  const controller = create();
  controllerRegistry.set(key, controller);
  return controller;
}

/** Give the details route its own draft, seeded from the project that opened it. */
export function createNewTaskDetailsController(
  port: NewTaskPort,
  context: NewTaskContext,
  projectId: string,
  seed: NewTaskSeed,
): NewTaskController {
  return new NewTaskController(port, context, {
    ...seed,
    project: seed.project ?? { kind: "existing", id: projectId },
  });
}

export type NewTaskSheetDestination = { kind: "back" } | { kind: "project"; projectId: string };

/** Select where the details route should land after an accepted task start. */
export function newTaskSheetDestination(
  openedFromProjectId: string,
  project: StartAgentSpace | undefined,
  choices: readonly StartSpaceChoice[],
  layout: Layout | undefined,
  startedSpaceId: string | undefined,
): NewTaskSheetDestination {
  if (project?.kind === "new") {
    return startedSpaceId === undefined
      ? { kind: "back" }
      : { kind: "project", projectId: startedSpaceId };
  }

  if (project?.kind !== "existing") return { kind: "back" };
  const choice = findProjectChoice(project, choices, layout);
  const projectId = choice?.displayId ?? project.id;
  return projectTaskId(projectId, layout) === projectTaskId(openedFromProjectId, layout)
    ? { kind: "back" }
    : { kind: "project", projectId };
}

/** Use one success path for Add and Retry while retaining the draft after failure. */
export async function submitNewTaskSheet(
  controller: NewTaskController,
  openedFromProjectId: string,
  layout: Layout | undefined,
  onSuccess: (destination: NewTaskSheetDestination) => void,
): Promise<NewTaskGoResult> {
  const result = await controller.go();
  if (result === "started") {
    onSuccess(
      newTaskSheetDestination(
        openedFromProjectId,
        controller.state.draft.project,
        controller.state.options.spaceChoices,
        layout,
        controller.lastStartedSpaceId,
      ),
    );
  }
  return result;
}

export function buildTaskText(title: string, notes: string): string {
  const normalizedTitle = title.trim();
  const normalizedNotes = notes.trim();
  return normalizedNotes.length > 0 ? `${normalizedTitle}\n\n${normalizedNotes}` : normalizedTitle;
}

export function runNeedsHerdrOpen(
  catalog: AgentCatalog | undefined,
  run: StartRunSelection | undefined,
): boolean {
  if (catalog?.windowOpen !== false || run?.kind !== "program") return false;
  const program = run.id.toLowerCase();
  return program !== "claude" && program !== "codex";
}

/** Match display ids and request target ids to the same startable space. */
export function findProjectChoice(
  project: StartAgentSpace | undefined,
  choices: readonly StartSpaceChoice[],
  layout: Layout | undefined,
): StartSpaceChoice | undefined {
  if (project?.kind === "new") {
    return choices.find((choice) => choice.selection.kind === "new");
  }
  if (project?.kind !== "existing") return undefined;
  const targetId = projectTaskId(project.id, layout);
  return choices.find(
    (choice) =>
      choice.selection.kind === "existing" &&
      (choice.selection.id === targetId ||
        choice.displayId === project.id ||
        choice.displayId === targetId),
  );
}

/** Home lists display ids while start requests use the real target ids. */
export function startableHomeProjects<T extends { id: string }>(
  projects: readonly T[],
  choices: readonly StartSpaceChoice[],
  layout: Layout | undefined,
): T[] {
  return projects.filter(
    (project) =>
      findProjectChoice({ kind: "existing", id: project.id }, choices, layout) !== undefined,
  );
}

export function newTaskFolders(
  options: StartOptions,
  project: StartAgentSpace | undefined,
): readonly FolderSuggestion[] {
  return options.foldersBySpace[startSpaceKey(project) ?? ""] ?? [];
}

function startFailure(cause: unknown): {
  code?: string;
  field?: "run" | "folder" | "task";
  message: string;
  refresh: boolean;
} {
  if (cause instanceof BridgeApiError) {
    if (cause.code === "task_not_allowed") {
      return {
        code: cause.code,
        field: "task",
        message: "Write the task as a sentence.",
        refresh: false,
      };
    }
    if (cause.code.startsWith("folder_")) {
      return {
        code: cause.code,
        field: "folder",
        message: "Choose a folder under an allowed root.",
        refresh: false,
      };
    }
    if (cause.code === "run_not_allowed") {
      return {
        code: cause.code,
        message: isClosedWindowProgramMessage(cause.message)
          ? cause.message
          : "That agent isn’t available.",
        refresh: true,
      };
    }
    if (
      cause.code === "not_connected" ||
      cause.code === "token_unavailable" ||
      cause.code === "connection_lost" ||
      cause.code === "request_timeout"
    ) {
      return { code: cause.code, message: "Can’t reach your Mac.", refresh: false };
    }
  }
  return {
    ...(cause instanceof BridgeApiError ? { code: cause.code } : {}),
    message:
      cause instanceof BridgeApiError
        ? errorMessage(cause, "Couldn't start the task. Try again.")
        : "Can’t reach your Mac.",
    refresh: false,
  };
}

function projectSelectionAvailable(
  project: StartAgentSpace | undefined,
  choices: readonly StartSpaceChoice[],
  layout: Layout | undefined,
): boolean {
  return findProjectChoice(project, choices, layout) !== undefined;
}

function projectSelectionForChoice(
  choice: StartSpaceChoice,
  current: StartAgentSpace | undefined,
): StartAgentSpace {
  if (choice.selection.kind === "existing") return choice.selection;
  return {
    kind: "new",
    ...(current?.kind === "new" && current.name !== undefined ? { name: current.name } : {}),
  };
}

function closedWindowRunMessage(run: StartRunSelection | undefined): string {
  return run?.kind === "program"
    ? `${run.id} gets a first message only while Herdr is open on your Mac.`
    : "This program needs Herdr open on your Mac.";
}

function isClosedWindowProgramMessage(message: string): boolean {
  return /^[^\r\n]+ gets a first message only while Herdr is open on your Mac\.$/u.test(message);
}

function addPendingRecord(records: readonly TaskRecord[], record: TaskRecord): TaskRecord[] {
  return records.some((pending) => pending.id === record.id) ? [...records] : [...records, record];
}

function samePendingRecords(left: readonly TaskRecord[], right: readonly TaskRecord[]): boolean {
  return (
    left.length === right.length && left.every((record, index) => record.id === right[index]?.id)
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function sameRunSelection(
  left: StartRunSelection | undefined,
  right: StartRunSelection | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind || left.kind === "empty") return false;
  return left.kind === "program"
    ? right.kind === "program" && left.id === right.id
    : right.kind === "template" && left.name === right.name;
}

export function sameProjectSelection(
  left: StartAgentSpace | undefined,
  right: StartAgentSpace | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === "existing"
    ? right.kind === "existing" && left.id === right.id
    : right.kind === "new";
}
