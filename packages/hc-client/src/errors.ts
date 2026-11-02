import type { JsonValue } from "@herdr-mobile/protocol";

/** A JSON-RPC error object as the core sent it, extension fields included. */
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
  [key: string]: JsonValue | undefined;
}

/** An error reply. herdr-core puts a stable `kind` and a `hint` in `data`. */
export class HcRpcError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;
  readonly kind: string | undefined;
  readonly hint: string | undefined;
  /** The error object exactly as received. */
  readonly error: RpcErrorObject;

  constructor(error: RpcErrorObject) {
    super(error.message);
    this.name = "HcRpcError";
    this.code = error.code;
    this.data = error.data;
    this.error = error;
    const data = error.data;
    const fields = typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
    this.kind = typeof fields.kind === "string" ? fields.kind : undefined;
    this.hint = typeof fields.hint === "string" ? fields.hint : undefined;
  }

  toObject(): RpcErrorObject {
    return this.error;
  }
}

/** The connection ended. `cause` says why, when something went wrong. */
export class TransportClosedError extends Error {
  constructor(cause?: unknown) {
    super("hc connection closed");
    this.name = "TransportClosedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** The stream this handle belonged to has ended. */
export class StreamClosedError extends Error {
  constructor() {
    super("hc stream closed");
    this.name = "StreamClosedError";
  }
}

/** The core sent something the protocol doesn't allow. The connection ends. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
