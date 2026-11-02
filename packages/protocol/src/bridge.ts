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

/** WebSocket close codes used by the bridge. */
export const BRIDGE_WS_CLOSE_CODES = {
  BAD_TOKEN: 4401,
  CHILD_EXITED: 1011,
} as const;
