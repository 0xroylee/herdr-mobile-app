// A herdr-core connection: the caller feeds bytes in and runs the writes out. Requests register
// before they are written and settle by id, following json-rpc-2.0's JSONRPCClient. Writes run one
// at a time, in order. end() settles everything still open.

import type { HcMethod, HcParams, HcResult, JsonRpcNotification } from "@herdr-mobile/protocol";
import { HcRpcError, ProtocolError, type RpcErrorObject, TransportClosedError } from "./errors.ts";
import { LineDecoder } from "./lines.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

export interface ClientOptions {
  /** Sends bytes to the core. The client calls it one write at a time, in order. */
  write(bytes: Uint8Array): void | Promise<void>;
  /** Closes the caller's transport. Ending a plain subscription needs it. */
  requestTransportClose?(): void | Promise<void>;
}

export type NotificationListener = (notification: JsonRpcNotification) => void;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WriteJob {
  bytes: Uint8Array;
  epoch: number;
  resolve(): void;
  reject(error: unknown): void;
  /** Runs synchronously when this write fails, before the connection ends. */
  onError: ((error: unknown) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return isRecord(value) && typeof value.then === "function";
}

/** The error a failed write reports, as json-rpc-2.0 words it when the writer gave no message. */
function sendError(error: unknown): Error {
  if (error instanceof Error && error.message) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return new Error(error.message);
  }
  return new Error("Failed to send a request");
}

export function createClient(options: ClientOptions): HcClient {
  return new HcClient(options);
}

export class HcClient {
  /** Resolves when the connection ends, with the cause when something went wrong. */
  readonly closed: Promise<unknown>;
  private readonly writeBytes: ClientOptions["write"];
  private readonly lines = new LineDecoder();
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<NotificationListener>();
  private nextId = 1;
  private epoch = 0;
  private ended = false;
  private endCause: unknown;
  private queue: WriteJob[] = [];
  private active: WriteJob | undefined;
  private pumping = false;
  private inbound: Uint8Array[] = [];
  private feeding = false;
  private resolveClosed: (cause: unknown) => void = () => {};

  constructor(options: ClientOptions) {
    this.writeBytes = options.write;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get isClosed(): boolean {
    return this.ended;
  }

  call<M extends HcMethod>(method: M, params: HcParams<M>): Promise<HcResult<M>> {
    return this.request(method, params) as Promise<HcResult<M>>;
  }

  /** Listens for messages without an id. Returns a function that stops listening. */
  onNotification(listener: NotificationListener): () => void {
    if (!this.ended) this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Feeds bytes read from the transport, in any chunking. A listener that feeds again while
   * this call is dispatching gets its bytes handled after the current ones, in order. Rethrows
   * the first listener error once everything fed so far is dispatched.
   */
  feed(bytes: Uint8Array): void {
    if (this.ended) return;
    this.inbound.push(bytes);
    if (this.feeding) return;
    this.feeding = true;
    let listenerError: unknown;
    try {
      while (this.inbound.length > 0 && !this.ended) {
        const failure = this.consume(this.inbound.shift() as Uint8Array);
        if (listenerError === undefined) listenerError = failure;
      }
    } finally {
      this.feeding = false;
    }
    if (listenerError !== undefined) throw listenerError;
  }

  /** Ends the connection. Idempotent. The caller still owns and closes its transport. */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.epoch++;
    this.endCause = cause;
    for (const call of this.pending.values()) call.reject(new TransportClosedError(cause));
    this.pending.clear();
    const jobs = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = undefined;
    this.queue = [];
    for (const job of jobs) job.reject(new TransportClosedError(cause));
    this.listeners.clear();
    this.inbound = [];
    this.resolveClosed(cause);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new TransportClosedError(this.endCause));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = utf8Encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      this.enqueue(line, (error) => {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        call.reject(sendError(error));
      }).catch(() => {
        // The call settles through `pending`; this write promise has no other reader.
      });
    });
  }

  private enqueue(bytes: Uint8Array, onError?: (error: unknown) => void): Promise<void> {
    if (this.ended) return Promise.reject(new TransportClosedError(this.endCause));
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, epoch: this.epoch, resolve, reject, onError });
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active && !this.ended && this.queue.length > 0) {
        const job = this.queue.shift() as WriteJob;
        if (job.epoch !== this.epoch) {
          job.reject(new TransportClosedError(this.endCause));
          continue;
        }
        this.active = job;
        let result: unknown;
        try {
          result = this.writeBytes(job.bytes);
        } catch (error) {
          this.failWrite(job, error);
          break;
        }
        if (isPromiseLike(result)) {
          result.then(
            () => this.completeAsync(job),
            (error: unknown) => this.failAsync(job, error),
          );
          break;
        }
        this.active = undefined;
        job.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }

  private completeAsync(job: WriteJob): void {
    if (this.active !== job || job.epoch !== this.epoch) return;
    this.active = undefined;
    job.resolve();
    this.pump();
  }

  private failAsync(job: WriteJob, error: unknown): void {
    if (this.active !== job || job.epoch !== this.epoch) return;
    this.failWrite(job, error);
  }

  /** A failed write means the transport is gone: settle this write, then end everything else. */
  private failWrite(job: WriteJob, error: unknown): void {
    this.active = undefined;
    job.onError?.(error);
    job.reject(sendError(error));
    this.end(error);
  }

  /** Handles one fed chunk. Returns the first listener error, if any. */
  private consume(chunk: Uint8Array): unknown {
    let listenerError: unknown;
    try {
      this.lines.push(chunk);
      for (let line = this.lines.takeLine(); line && !this.ended; line = this.lines.takeLine()) {
        const failure = this.dispatch(this.parse(line.line));
        if (listenerError === undefined) listenerError = failure;
      }
    } catch (error) {
      this.end(error instanceof ProtocolError ? error : new ProtocolError(String(error)));
    }
    return listenerError;
  }

  private parse(bytes: Uint8Array): unknown {
    const text = utf8Decode(bytes);
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new ProtocolError(`invalid JSON from the core: ${text.slice(0, 120)}`);
    }
  }

  /** Routes one message. Returns a listener's error, if one threw. */
  private dispatch(message: unknown): unknown {
    if (message === undefined) return undefined;
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      throw new ProtocolError("message from the core is not JSON-RPC 2.0");
    }
    const isRequest = typeof message.method === "string";
    if (!("id" in message)) {
      return isRequest ? this.notify(message as unknown as JsonRpcNotification) : undefined;
    }
    // A reply, valid or not, settles its call. The core sends this client no requests.
    if (!isRequest) this.settle(message);
    return undefined;
  }

  private settle(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number") return;
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    const hasResult = "result" in message;
    const hasError = "error" in message;
    const error = message.error;
    if (hasResult && !hasError) {
      call.resolve(message.result);
    } else if (
      hasError &&
      !hasResult &&
      isRecord(error) &&
      typeof error.code === "number" &&
      typeof error.message === "string"
    ) {
      call.reject(new HcRpcError(error as RpcErrorObject));
    } else {
      call.reject(new ProtocolError(`invalid JSON-RPC response for request ${id}`));
    }
  }

  private notify(notification: JsonRpcNotification): unknown {
    let failure: unknown;
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    return failure;
  }
}
