import type {
  AgentCatalog,
  Role,
  StartAgentPlacement,
  StartAgentReply,
  StartAgentRequest,
  StartAgentSpace,
} from "@herdr-mobile/protocol";
import type { SpaceTargetId } from "../../model/spaceTarget.ts";
import {
  type StartDraft,
  type StartFieldErrors,
  type StartOptions,
  type StartRunSelection,
  startSpaceKey,
  validateStartDraft,
} from "../../model/startAgent.ts";
import { BridgeApiError } from "../../net/bridge-api.ts";
import type { NewItemResult } from "../spaces/newItems.ts";
import { getStartScreenAccess } from "./start-access.ts";

export interface StartAgentPort {
  catalog(): Promise<AgentCatalog>;
  start(request: StartAgentRequest): Promise<StartAgentReply>;
  haptic(): Promise<unknown> | unknown;
  openAgent(address: string, placement: StartAgentPlacement): void;
  openSpaces(spaceId?: string, placement?: StartAgentPlacement): void;
}

export interface StartControllerAccess {
  role: Role | undefined;
  connected: boolean;
}

export interface StartControllerState {
  status: "loading" | "editing" | "starting" | "done" | "error";
  catalog?: AgentCatalog;
  catalogError?: string;
  refreshAvailable?: boolean;
  error?: string;
  fieldErrors?: StartFieldErrors;
  reply?: StartAgentReply;
  draft: StartDraft;
}

/** Holds the Start form state and keeps bridge and navigation effects behind its port. */
export class StartController {
  private snapshot: StartControllerState;
  private readonly listeners = new Set<() => void>();
  private readonly port: StartAgentPort;
  private readonly preselectedSpaceTargetId: string | undefined;
  private availableRuns: StartRunSelection[] | undefined;
  private foldersBySpace: StartOptions["foldersBySpace"] = {};
  private userChoseSpace = false;
  private userSetFolder = false;
  private role: Role | undefined;
  private connected: boolean;

  constructor(
    port: StartAgentPort,
    preselectedSpaceTargetId?: string,
    access: StartControllerAccess = { role: "control", connected: true },
  ) {
    this.port = port;
    this.preselectedSpaceTargetId = preselectedSpaceTargetId;
    this.role = access.role;
    this.connected = access.connected;
    this.snapshot = {
      status: "loading",
      draft: { run: undefined, folder: "", space: undefined, task: "" },
    };
  }

  get state(): StartControllerState {
    return this.snapshot;
  }

  setAccess(role: Role | undefined, connected: boolean): void {
    this.role = role;
    this.connected = connected;
  }

  getSnapshot = (): StartControllerState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    const current = this.snapshot;
    if (current.status === "starting" || current.status === "done") return;
    this.setSnapshot({
      status: "loading",
      ...(current.catalog ? { catalog: current.catalog } : {}),
      ...(current.catalogError ? { catalogError: current.catalogError } : {}),
      ...(current.refreshAvailable ? { refreshAvailable: true } : {}),
      draft: current.draft,
    });
    try {
      const catalog = await this.port.catalog();
      this.setSnapshot({
        status: "editing",
        catalog,
        ...(catalog.templatesError ? { catalogError: catalog.templatesError } : {}),
        ...(catalog.templatesError ? {} : { refreshAvailable: false }),
        draft: this.snapshot.draft,
      });
    } catch (cause) {
      this.setSnapshot({
        status: "editing",
        catalogError: errorMessage(cause, "Couldn't load agent options. Built-ins are available."),
        refreshAvailable: false,
        draft: this.snapshot.draft,
      });
    }
  }

  /** Reconcile defaults and the preselection as spaces, folders, and catalog data arrive. */
  applyOptions(options: StartOptions): void {
    if (!isEditable(this.snapshot.status)) return;
    const draft = this.snapshot.draft;
    this.foldersBySpace = options.foldersBySpace;
    const selectableRuns = options.runChoices.filter((choice) => choice.kind !== "empty");
    this.availableRuns = selectableRuns.map((choice) => choice.selection);
    const visibleRun = options.runChoices.find((choice) => sameRun(choice.selection, draft.run));
    const run = visibleRun?.selection ?? selectableRuns[0]?.selection;
    const currentSpace = options.spaceChoices.find((choice) =>
      spaceSelectionMatches(choice.selection, draft.space),
    )?.selection;
    const preselectedSpace = options.spaceChoices.find(
      (choice) =>
        choice.selection.kind === "existing" &&
        choice.selection.id === this.preselectedSpaceTargetId,
    )?.selection;
    const firstSpace = options.spaceChoices[0]?.selection;
    const space = this.userChoseSpace
      ? (currentSpace ?? firstSpace)
      : (preselectedSpace ?? currentSpace ?? firstSpace);
    const spaceChanged = !spaceSelectionMatches(draft.space, space);
    const suggestedFolder = this.firstSuggestedFolder(space);
    const folder = this.userSetFolder
      ? draft.folder
      : spaceChanged || !draft.folder
        ? suggestedFolder
        : draft.folder;
    const { fieldErrors, ...state } = this.snapshot;
    const remainingErrors = { ...fieldErrors };
    if (folder !== draft.folder) delete remainingErrors.folder;
    this.setSnapshot({
      ...state,
      ...(Object.keys(remainingErrors).length > 0 ? { fieldErrors: remainingErrors } : {}),
      draft: { ...draft, run, space, folder },
    });
  }

  set(field: "run", value: StartRunSelection): void;
  set(field: "space", value: StartAgentSpace): void;
  set(field: "folder" | "task", value: string): void;
  set(
    field: "run" | "space" | "folder" | "task",
    value: StartRunSelection | StartAgentSpace | string,
  ): void {
    if (field === "run") {
      this.updateDraft({ run: value as StartRunSelection }, "run");
    } else if (field === "space") {
      if (!isEditable(this.snapshot.status)) return;
      this.userChoseSpace = true;
      const space = value as StartAgentSpace;
      const draft = this.snapshot.draft;
      const spaceChanged = !spaceSelectionMatches(draft.space, space);
      const folder =
        !this.userSetFolder && (spaceChanged || !draft.folder)
          ? this.firstSuggestedFolder(space)
          : draft.folder;
      const fields: (keyof StartFieldErrors)[] = ["space"];
      if (folder !== draft.folder) fields.push("folder");
      this.updateDraft({ space, folder }, ...fields);
    } else if (field === "folder") {
      if (!isEditable(this.snapshot.status)) return;
      this.userSetFolder = true;
      this.updateDraft({ folder: value as string }, "folder");
    } else {
      this.updateDraft({ task: value as string });
    }
  }

  async start(): Promise<boolean> {
    if (
      !isEditable(this.snapshot.status) ||
      !getStartScreenAccess(this.role, this.connected).canStart
    ) {
      return false;
    }
    const baseValidation = validateStartDraft(this.snapshot.draft);
    const runIsVisible = this.availableRuns?.some((run) => sameRun(run, this.snapshot.draft.run));
    const validation =
      this.availableRuns !== undefined && this.snapshot.draft.run !== undefined && !runIsVisible
        ? {
            ok: false as const,
            errors: {
              ...(baseValidation.ok ? {} : baseValidation.errors),
              run: "Choose a program or template.",
            },
          }
        : baseValidation;
    if (!validation.ok) {
      this.setSnapshot({
        ...this.snapshot,
        status: "editing",
        error: undefined,
        fieldErrors: validation.errors,
      });
      return false;
    }

    const { catalog, catalogError, draft } = this.snapshot;
    this.setSnapshot({
      status: "starting",
      ...(catalog ? { catalog } : {}),
      ...(catalogError ? { catalogError } : {}),
      draft,
    });
    try {
      const reply = await this.port.start(validation.request);
      try {
        await this.port.haptic();
      } catch {
        // A haptic failure must not undo a successful start.
      }
      if (reply.address) this.port.openAgent(reply.address, reply.placement);
      else this.port.openSpaces(reply.space.id, reply.placement);
      this.setSnapshot({ status: "done", reply, draft });
      return true;
    } catch (cause) {
      const message = errorMessage(cause, "Couldn't start the agent. Try again.");
      const fieldErrors: StartFieldErrors =
        cause instanceof BridgeApiError &&
        (cause.code === "folder_missing" || cause.code === "folder_not_allowed")
          ? { folder: message }
          : {};
      const refreshAvailable = cause instanceof BridgeApiError && cause.code === "run_not_allowed";
      this.setSnapshot({
        status: "error",
        ...(catalog ? { catalog } : {}),
        ...(catalogError ? { catalogError } : {}),
        error: message,
        ...(refreshAvailable ? { refreshAvailable: true } : {}),
        ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
        draft,
      });
      return false;
    }
  }

  async createEmptyTabIfAllowed(
    target: SpaceTargetId | undefined,
    createTab: (target: SpaceTargetId) => Promise<NewItemResult>,
  ): Promise<NewItemResult | undefined> {
    if (!getStartScreenAccess(this.role, this.connected).canStart || !target) return undefined;
    return createTab(target);
  }

  private updateDraft(changes: Partial<StartDraft>, ...fields: (keyof StartFieldErrors)[]): void {
    if (!isEditable(this.snapshot.status)) return;
    const { fieldErrors, ...state } = this.snapshot;
    const remainingErrors = { ...fieldErrors };
    for (const field of fields) delete remainingErrors[field];
    this.setSnapshot({
      ...state,
      status: "editing",
      error: undefined,
      ...(Object.keys(remainingErrors).length > 0 ? { fieldErrors: remainingErrors } : {}),
      draft: { ...this.snapshot.draft, ...changes },
    });
  }

  private firstSuggestedFolder(space: StartAgentSpace | undefined): string {
    const folderKey = startSpaceKey(space);
    return this.foldersBySpace[folderKey ?? ""]?.[0]?.path ?? "";
  }

  private setSnapshot(snapshot: StartControllerState): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function isEditable(status: StartControllerState["status"]): boolean {
  return status === "editing" || status === "error";
}

export function createStartController(
  port: StartAgentPort,
  preselectedSpaceTargetId?: string,
  access?: StartControllerAccess,
): StartController {
  return new StartController(port, preselectedSpaceTargetId, access);
}

function spaceSelectionMatches(
  left: StartAgentSpace | undefined,
  right: StartAgentSpace | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    right !== undefined &&
    left.kind === right.kind &&
    (left.kind === "existing"
      ? right.kind === "existing" && left.id === right.id
      : right.kind === "new")
  );
}

function sameRun(left: StartRunSelection, right: StartRunSelection | undefined): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "empty") return right.kind === "empty";
  return left.kind === "program"
    ? right.kind === "program" && left.id === right.id
    : right.kind === "template" && left.name === right.name;
}

export function dispatchStartAction(
  run: StartRunSelection | undefined,
  actions: { start(): Promise<unknown>; createEmptyTab(): Promise<unknown> },
): Promise<unknown> {
  return run?.kind === "empty" ? actions.createEmptyTab() : actions.start();
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
