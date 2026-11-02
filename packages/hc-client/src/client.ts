// A herdr-core connection: the caller feeds bytes in and runs the writes out. Requests register
// before they are written and settle by id, following json-rpc-2.0's JSONRPCClient. Writes run one
// at a time, in order. hello() moves the connection to framed mode behind an admission barrier;
// then channel 0 carries JSON-RPC and every other channel's frames go to its routed handler.
// end() settles everything still open.

import {
  type Frame,
  FrameKind,
  HC_PROTOCOL_GENERATION,
  type HcMethod,
  type HcParams,
  type HcResult,
  INITIAL_STREAM_CREDIT,
  type JsonRpcNotification,
} from "@herdr-mobile/protocol";
import { HcRpcError, ProtocolError, type RpcErrorObject, TransportClosedError } from "./errors.ts";
import { encodeFrame, FrameDecoder } from "./frame.ts";
import { LineDecoder } from "./lines.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

export interface ClientOptions {
  /** Sends bytes to the core. The client calls it one write at a time, in order. */
  write(bytes: Uint8Array): void | Promise<void>;
  /** Closes the caller's transport. Ending a plain subscription needs it. */
  requestTransportClose?(): void | Promise<void>;
}

export type NotificationListener = (notification: JsonRpcNotification) => void;

/** Receives every frame on one nonzero channel, in order. */
export type ChannelHandler = (frame: Frame) => void;

type Mode = "plain" | "hello-draining" | "hello-pending" | "framed";

const HELLO_IN_PROGRESS = "hello negotiation in progress";

/** DATA bytes kept for a channel nobody has routed yet. */
const MAX_STASHED_BYTES = INITIAL_STREAM_CREDIT;

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
  private readonly frames = new FrameDecoder();
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly channels = new Map<number, ChannelHandler>();
  private readonly stashed = new Map<number, { frames: Frame[]; bytes: number }>();
  private mode: Mode = "plain";
  private nextId = 1;
  private epoch = 0;
  private ended = false;
  private endCause: unknown;
  private queue: WriteJob[] = [];
  private active: WriteJob | undefined;
  private pumping = false;
  private inbound: Uint8Array[] = [];
  private feeding = false;
  private drainWaiters: (() => void)[] = [];
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

  /** True once hello switched the connection to framed mode. */
  get isFramed(): boolean {
    return this.mode === "framed";
  }

  call<M extends HcMethod>(method: M, params: HcParams<M>): Promise<HcResult<M>> {
    if (method === "hello") return Promise.reject(new Error("negotiate with hello(), not call()"));
    return this.request(method, params) as Promise<HcResult<M>>;
  }

  /**
   * Negotiates protocol generation 1 and, with `framed`, framed mode. Waits for the calls already
   * accepted, sends hello alone, and reads frames from the byte after its reply. Calls made
   * meanwhile reject with "hello negotiation in progress" and write nothing. An error reply leaves
   * the connection plain.
   */
  async hello({ framed }: { framed: boolean } = { framed: true }): Promise<HcResult<"hello">> {
    if (this.ended) throw new TransportClosedError(this.endCause);
    if (this.mode !== "plain") {
      throw new Error(this.mode === "framed" ? "hello already completed" : HELLO_IN_PROGRESS);
    }
    this.mode = "hello-draining";
    await this.drained();
    if (this.ended) throw new TransportClosedError(this.endCause);
    this.mode = "hello-pending";
    const id = this.nextId++;
    const params = { generation: HC_PROTOCOL_GENERATION, framed };
    const bytes = this.encodeMessage({ jsonrpc: "2.0", id, method: "hello", params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => this.completeHello(result, framed, resolve, reject),
        reject: (error) => {
          if (!this.ended) this.mode = "plain";
          reject(error);
        },
      });
      this.enqueue(bytes, (error) => this.failCall(id, error)).catch(() => {
        // The hello call settles through `pending`.
      });
    });
  }

  /** Listens for messages without an id. Returns a function that stops listening. */
  onNotification(listener: NotificationListener): () => void {
    if (!this.ended) this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Routes one nonzero channel's frames to `handler`, first replaying any that arrived before it
   * was routed. For attach and subscription handles; returns a function that unroutes it.
   */
  routeChannel(channel: number, handler: ChannelHandler): () => void {
    if (this.ended) return () => {};
    this.channels.set(channel, handler);
    const early = this.stashed.get(channel);
    this.stashed.delete(channel);
    for (const frame of early?.frames ?? []) handler(frame);
    return () => {
      if (this.channels.get(channel) === handler) this.channels.delete(channel);
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
    this.channels.clear();
    this.stashed.clear();
    this.inbound = [];
    this.notifyDrained();
    this.resolveClosed(cause);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new TransportClosedError(this.endCause));
    if (this.mode === "hello-draining" || this.mode === "hello-pending") {
      return Promise.reject(new Error(HELLO_IN_PROGRESS));
    }
    const id = this.nextId++;
    let bytes: Uint8Array;
    try {
      bytes = this.encodeMessage({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.enqueue(bytes, (error) => this.failCall(id, error)).catch(() => {
        // The call settles through `pending`; this write promise has no other reader.
      });
    });
  }

  private failCall(id: number, error: unknown): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    call.reject(sendError(error));
  }

  private completeHello(
    result: unknown,
    framed: boolean,
    resolve: (result: HcResult<"hello">) => void,
    reject: (error: unknown) => void,
  ): void {
    const reply = isRecord(result) ? result : {};
    if (reply.generation !== HC_PROTOCOL_GENERATION) {
      // The core may have switched to framing nobody here can read: end the connection.
      const error = new Error(`Unsupported protocol generation: ${String(reply.generation)}`);
      reject(error);
      this.end(error);
      return;
    }
    if (framed && reply.framed !== true) {
      this.mode = "plain";
      reject(new Error("the core did not switch to framed mode"));
      return;
    }
    // Switch before anyone sees the result, so the bytes after the reply are read as frames.
    this.mode = framed ? "framed" : "plain";
    resolve(result as unknown as HcResult<"hello">);
  }

  private encodeMessage(message: object): Uint8Array {
    const json = JSON.stringify(message);
    return this.mode === "framed"
      ? encodeFrame({ channel: 0, kind: FrameKind.Data, payload: utf8Encode(json) })
      : utf8Encode(`${json}\n`);
  }

  /**
   * Resolves once no accepted call awaits a reply. Their writes are then done too, or queued
   * ahead of anything written next.
   */
  private drained(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.ended || this.pending.size === 0;
  }

  private notifyDrained(): void {
    if (!this.isIdle() || this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) waiter();
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
    const note = (failure: unknown) => {
      if (listenerError === undefined) listenerError = failure;
    };
    try {
      if (this.isFramed) {
        note(this.consumeFrames(chunk));
        return listenerError;
      }
      this.lines.push(chunk);
      let line = this.lines.takeLine();
      while (line && !this.ended) {
        note(this.dispatch(this.parse(line.line)));
        // hello's reply can switch the mode: the rest of this input is then frames.
        line = this.isFramed ? undefined : this.lines.takeLine();
      }
      if (this.isFramed && !this.ended) note(this.consumeFrames(this.lines.drain()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.end(error instanceof ProtocolError ? error : new ProtocolError(message));
    }
    return listenerError;
  }

  private consumeFrames(bytes: Uint8Array): unknown {
    let listenerError: unknown;
    for (const frame of this.frames.push(bytes)) {
      if (this.ended) break;
      let failure: unknown;
      if (frame.channel !== 0) {
        failure = this.route(frame);
      } else if (frame.kind === FrameKind.Data) {
        failure = this.dispatch(this.parse(frame.payload));
      }
      if (listenerError === undefined) listenerError = failure;
    }
    return listenerError;
  }

  private route(frame: Frame): unknown {
    const handler = this.channels.get(frame.channel);
    if (handler) {
      try {
        handler(frame);
      } catch (error) {
        return error;
      }
      return undefined;
    }
    // A stream's first frames can arrive before the reply that names its channel. Keep them;
    // without credit from this client the core can't send more than the opening credit.
    const stash = this.stashed.get(frame.channel) ?? { frames: [], bytes: 0 };
    stash.frames.push(frame);
    if (frame.kind === FrameKind.Data) stash.bytes += frame.payload.length;
    if (stash.bytes > MAX_STASHED_BYTES) {
      throw new ProtocolError(
        `channel ${frame.channel} sent ${stash.bytes} bytes before anyone read it`,
      );
    }
    this.stashed.set(frame.channel, stash);
    return undefined;
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
    this.notifyDrained();
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
