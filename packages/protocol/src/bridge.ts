/** Protocol version spoken by the phone during bridge authentication. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export type Role = "watch" | "control";

export interface BridgeMachine {
  id: string;
  name: string;
}

/** Redeem a one-time pairing code for a new device token. */
export interface PairRequest {
  code: string;
  name?: string;
}

/** Successful response to `POST /api/pair`. The token is shown once. */
export interface PairReply {
  deviceId: string;
  token: string;
  role: Role;
  machine: BridgeMachine;
}

/** First text message sent after the WebSocket upgrade. */
export interface AuthMessage {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  token: string;
}

/** Successful response to the WebSocket authentication message. */
export interface AuthReply {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  ok: true;
  role: Role;
  machine: BridgeMachine;
}

/** Device details safe to return from the bridge's device-list endpoint. */
export interface DeviceRecordView {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number | null;
}

/** JSON body returned with a non-success HTTP status. */
export interface HttpErrorBody {
  error: string;
  message?: string;
}

/** A built-in program or a template that the bridge allows the phone to start. */
export type StartAgentRun = { kind: "program"; id: string } | { kind: "template"; name: string };

/** Start in a space that exists already, or ask the bridge to create one. */
export type StartAgentSpace = { kind: "existing"; id: string } | { kind: "new"; name?: string };

/** Request to start an allowed run in a folder and space. */
export interface StartAgentRequest {
  run: StartAgentRun;
  folder: string;
  space: StartAgentSpace;
  /** Optional first message passed to the agent as its initial prompt. */
  task?: string;
}

/** The bridge chose to start the terminal in the Herdr window or herdr-core. */
export type StartAgentPlacement = "window" | "core";

/** Space or tab id returned by a successful start. */
export interface StartAgentLocation {
  id: string;
  isNew: boolean;
}

/** Successful response to `POST /api/agents/start`. */
export interface StartAgentReply {
  placement: StartAgentPlacement;
  /** Terminal address, when the selected start path returns one. */
  address?: string;
  space: StartAgentLocation;
  tab: StartAgentLocation;
}

/** Template offered by `GET /api/agents/catalog`. */
export interface AgentCatalogTemplate {
  name: string;
  description: string;
}

/** Start options and folder constraints offered by the bridge. */
export interface AgentCatalog {
  programs: string[];
  templates: AgentCatalogTemplate[];
  /** Present when the bridge could not load the template list. */
  templatesError?: string;
  /** Folders the bridge permits the phone to select. */
  roots: string[];
  home: string;
  windowOpen: boolean;
}

/** Error codes returned by `POST /api/agents/start`. */
export type StartAgentErrorCode =
  | "forbidden"
  | "run_not_allowed"
  | "folder_not_allowed"
  | "folder_missing"
  | "core_unavailable"
  | "herdr_app_failed"
  | "herdr_app_timeout";

/** Start error response, including the underlying core error kind when present. */
export interface StartAgentErrorBody extends HttpErrorBody {
  error: StartAgentErrorCode;
  /** Error kind returned by herdr-core, such as `invalid_template`. */
  kind?: string;
}

/** WebSocket close codes used by the bridge. */
export const BRIDGE_WS_CLOSE_CODES = {
  BAD_TOKEN: 4401,
  CHILD_EXITED: 1011,
} as const;
