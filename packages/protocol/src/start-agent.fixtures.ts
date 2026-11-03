// Wire type fixtures checked by `bun run typecheck` and never imported.

import type {
  AgentCatalog,
  AgentCatalogTemplate,
  StartAgentErrorBody,
  StartAgentErrorCode,
  StartAgentLocation,
  StartAgentPlacement,
  StartAgentReply,
  StartAgentRequest,
  StartAgentRun,
  StartAgentSpace,
} from "./bridge.ts";

export const programRun: StartAgentRun = { kind: "program", id: "claude" };
export const templateRun: StartAgentRun = { kind: "template", name: "review" };
export const existingSpace: StartAgentSpace = { kind: "existing", id: "sp1" };
export const newSpace: StartAgentSpace = { kind: "new", name: "Research" };
export const unnamedSpace: StartAgentSpace = { kind: "new" };

export const programRequest: StartAgentRequest = {
  run: programRun,
  folder: "/Users/roy/project",
  space: existingSpace,
};
export const templateRequest: StartAgentRequest = {
  run: templateRun,
  folder: "/Users/roy/project",
  space: newSpace,
  task: "Inspect the current branch",
};

export const windowPlacement: StartAgentPlacement = "window";
export const corePlacement: StartAgentPlacement = "core";
export const location: StartAgentLocation = { id: "sp1", isNew: false };
export const windowReply: StartAgentReply = {
  placement: "window",
  address: "local/t1",
  space: { id: "sp1", isNew: false },
  tab: { id: "tb2", isNew: true },
};
export const coreReply: StartAgentReply = {
  placement: "core",
  space: { id: "sp2", isNew: true },
  tab: { id: "tb3", isNew: true },
};

export const template: AgentCatalogTemplate = { name: "review", description: "Review code" };
export const catalog: AgentCatalog = {
  programs: ["claude", "codex"],
  templates: [template],
  templatesError: "Templates could not be loaded",
  roots: ["/Users/roy"],
  home: "/Users/roy",
  windowOpen: false,
};

export const forbiddenCode: StartAgentErrorCode = "forbidden";
export const startError: StartAgentErrorBody = {
  error: "core_unavailable",
  message: "herdr-core could not start the agent",
  kind: "invalid_template",
};

/** True only when A and B have the same type. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const startAgentPlacementShape: Equals<StartAgentPlacement, "window" | "core"> = true;
const startAgentLocationShape: Equals<StartAgentLocation, { id: string; isNew: boolean }> = true;
const agentCatalogTemplateShape: Equals<
  AgentCatalogTemplate,
  { name: string; description: string }
> = true;
const startAgentRunShape: Equals<
  StartAgentRun,
  { kind: "program"; id: string } | { kind: "template"; name: string }
> = true;
const startAgentSpaceShape: Equals<
  StartAgentSpace,
  { kind: "existing"; id: string } | { kind: "new"; name?: string }
> = true;
const startAgentRequestShape: Equals<
  StartAgentRequest,
  { run: StartAgentRun; folder: string; space: StartAgentSpace; task?: string }
> = true;
const startAgentReplyShape: Equals<
  StartAgentReply,
  {
    placement: StartAgentPlacement;
    address?: string;
    space: StartAgentLocation;
    tab: StartAgentLocation;
  }
> = true;
const agentCatalogShape: Equals<
  AgentCatalog,
  {
    programs: string[];
    templates: AgentCatalogTemplate[];
    templatesError?: string;
    roots: string[];
    home: string;
    windowOpen: boolean;
  }
> = true;
const startAgentErrorShape: Equals<
  StartAgentErrorCode,
  | "forbidden"
  | "run_not_allowed"
  | "folder_not_allowed"
  | "folder_missing"
  | "core_unavailable"
  | "herdr_app_failed"
  | "herdr_app_timeout"
> = true;
const startAgentErrorBodyShape: Equals<
  StartAgentErrorBody,
  { error: StartAgentErrorCode; message?: string; kind?: string }
> = true;

export const exactShapes = [
  startAgentPlacementShape,
  startAgentLocationShape,
  agentCatalogTemplateShape,
  startAgentRunShape,
  startAgentSpaceShape,
  startAgentRequestShape,
  startAgentReplyShape,
  agentCatalogShape,
  startAgentErrorShape,
  startAgentErrorBodyShape,
] as const;

// @ts-expect-error program runs require an id
export const programWithoutId: StartAgentRun = { kind: "program" };
// @ts-expect-error templates require a name
export const templateWithoutName: StartAgentRun = { kind: "template" };
// @ts-expect-error only existing or new spaces are accepted
export const arbitrarySpace: StartAgentSpace = { kind: "folder", id: "sp1" };
// @ts-expect-error the location's new flag is required
export const locationWithoutIsNew: StartAgentLocation = { id: "sp1" };
// @ts-expect-error only window or core is a placement
export const unsupportedPlacement: StartAgentPlacement = "shell";
// @ts-expect-error unsupported start errors must remain outside the union
export const unknownStartError: StartAgentErrorCode = "unknown_error";
