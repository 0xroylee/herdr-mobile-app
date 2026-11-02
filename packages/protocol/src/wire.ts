// Framed-mode wire contract, as herdr-core's wire.rs defines it:
// [channel u32 LE][kind u8][len u32 LE][payload]. Channel 0 carries JSON-RPC.

export const FRAME_HEADER_BYTES = 9;

/** Largest payload either side may put in one frame. */
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** Frame kinds. A decoder keeps unknown values as they arrive. */
export const FrameKind = {
  /** Channel 0: one JSON-RPC message. Other channels: stream bytes. */
  Data: 0,
  /** u32 LE: bytes the receiver consumed; the sender may send that much more. */
  Credit: 1,
  /** The channel is over: a JSON reason from the core, empty from a client. */
  Close: 2,
  /** Viewer to core: u16 LE cols, then u16 LE rows. */
  Resize: 3,
  /** Viewer to core: 1 gained focus, 0 lost it. */
  Focus: 4,
  /** Viewer to core: JSON display facts. */
  Facts: 5,
} as const;

/** Credit a stream starts with before the viewer acknowledges anything. */
export const INITIAL_STREAM_CREDIT = 256 * 1024;

/** A viewer further behind than this gets a repaint instead of the backlog. */
export const MAX_STREAM_LAG = 4 * 1024 * 1024;

export interface Frame {
  channel: number;
  kind: number;
  payload: Uint8Array;
}

/** A JSON-RPC message without an id: herdr-core's `event`, `heartbeat` and `missed`. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
