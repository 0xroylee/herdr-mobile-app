// A herdr-core connection: the caller feeds bytes in and runs the writes out. Requests register
// before they are written and settle by id, following json-rpc-2.0's JSONRPCClient. Writes run one
// at a time, in order. hello() moves the connection to framed mode behind an admission barrier;
// then channel 0 carries JSON-RPC and every other channel's frames go to its routed handler, such
// as an attachment or a subscription. A plain subscription turns the connection into a stream of
// notifications behind the same kind of barrier. end() settles everything still open.

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
import { type AttachHandle, Attachment, type AttachOptions } from "./attach.ts";
import {
  HcRpcError,
  ProtocolError,
  type RpcErrorObject,
  StreamClosedError,
  TransportClosedError,
} from "./errors.ts";
import { encodeFrame, FrameDecoder } from "./frame.ts";
import { isPromiseLike, isRecord } from "./guards.ts";
import { LineDecoder } from "./lines.ts";
import {
  type EventSnapshot,
  type EventSubscription,
  type SubscribeCallbacks,
  Subscription,
} from "./subscribe.ts";
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

type Mode =
  | "plain"
  | "hello-draining"
  | "hello-pending"
  | "framed"
  | "subscribe-draining"
  | "subscribe-pending"
  | "notifications";

const HELLO_IN_PROGRESS = "hello negotiation in progress";
const SUBSCRIBE_IN_PROGRESS = "plain subscription transition in progress";
const NOTIFICATIONS_ONLY = "plain subscription is notification-only";

/** DATA bytes kept for a channel nobody has routed yet. */
const MAX_STASHED_BYTES = INITIAL_STREAM_CREDIT;

interface PendingCall {
  /** Runs synchronously with the result, before later input is read. Returns a listener error. */
  resolve(value: unknown): unknown;
  reject(error: unknown): void;
}

interface WriteJob {
  bytes: Uint8Array;
  epoch: number;
  resolve(): void;
  reject(error: unknown): void;
  /** Runs synchronously when this write fails, before the connection ends. */
  onError: ((error: unknown) => void) | undefined;
  /** A stream frame's check, made again when its turn comes: false drops it unwritten. */
  valid: (() => boolean) | undefined;
}

/** The error a failed write reports, as json-rpc-2.0 words it when the writer gave no message. */
function sendError(error: unknown): Error {
  if (error instanceof Error && error.message) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return new Error(error.message);
  }
  return new Error("Failed to send a request");
}

function isChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

export function createClient(options: ClientOptions): HcClient {
  return new HcClient(options);
}

export class HcClient {
  /** Resolves when the connection ends, with the cause when something went wrong. */
  readonly closed: Promise<unknown>;
  private readonly writeBytes: ClientOptions["write"];
  private readonly requestTransportClose: ClientOptions["requestTransportClose"];
  private readonly lines = new LineDecoder();
  private readonly frames = new FrameDecoder();
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly channels = new Map<number, ChannelHandler>();
  private readonly attachments = new Map<number, Attachment>();
  private readonly subscriptions = new Map<number, Subscription>();
  /** The subscription a plain connection carries, once its reply is in. */
  private plainSubscription: Subscription | undefined;
  /** Channels whose stream is over. The core never reuses one, so their late frames are dropped. */
  private readonly closedChannels = new Set<number>();
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
    this.requestTransportClose = options.requestTransportClose?.bind(options);
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

  /** Whether call() would send now: not ended, and no transition or plain subscription. */
  get acceptsCalls(): boolean {
    return this.refusal() === undefined;
  }

  call<M extends HcMethod>(method: M, params: HcParams<M>): Promise<HcResult<M>> {
    if (method === "hello") return Promise.reject(new Error("negotiate with hello(), not call()"));
    if (method === "terminal.attach") {
      return Promise.reject(new Error("open attachments with attach(), not call()"));
    }
    if (method === "events.subscribe") {
      return Promise.reject(new Error("subscribe with subscribeEvents(), not call()"));
    }
    return this.request(method, params) as Promise<HcResult<M>>;
  }

  /**
   * Attaches to a terminal over a framed connection. The first paint can arrive before the reply;
   * it is kept and given to `onData` first. See AttachHandle for input, credit and detach.
   */
  async attach(params: HcParams<"terminal.attach">, options: AttachOptions): Promise<AttachHandle> {
    if (this.ended) throw new TransportClosedError(this.endCause);
    if (!this.isFramed) throw new Error("attach needs a framed connection: call hello() first");
    const result = (await this.request("terminal.attach", params)) as HcResult<"terminal.attach">;
    if (this.ended) throw new TransportClosedError(this.endCause);
    const { channel } = result;
    const attachment = new Attachment(
      {
        send: (kind, payload, valid) => this.enqueueFrame({ channel, kind, payload }, valid),
        release: () => this.releaseChannel(channel),
      },
      channel,
      result.terminal,
      params.observe === true,
      options,
    );
    this.attachments.set(channel, attachment);
    this.routeChannel(channel, (frame) => attachment.receive(frame));
    return attachment;
  }

  /**
   * Subscribes to events with `filter` sent as given. On a framed connection the events come on
   * their own channel, and several subscriptions can run side by side. On a plain one this waits
   * for the calls already accepted, and the connection then carries only this subscription:
   * calls made from now on reject. The callbacks get the snapshot first, then what follows it.
   */
  async subscribeEvents(
    filter: HcParams<"events.subscribe">,
    callbacks: SubscribeCallbacks = {},
  ): Promise<EventSubscription> {
    const refused = this.refusal();
    if (refused) throw refused;
    if (!this.isFramed) {
      return this.transition(
        ["subscribe-draining", "subscribe-pending"],
        "events.subscribe",
        filter,
        (result, resolve, reject) =>
          this.startSubscription(result, false, callbacks, resolve, reject),
      );
    }
    return new Promise((resolve, reject) => {
      this.send("events.subscribe", filter, {
        resolve: (result) => this.startSubscription(result, true, callbacks, resolve, reject),
        reject,
      });
    });
  }

  /**
   * Negotiates protocol generation 1 and, with `framed`, framed mode. Waits for the calls already
   * accepted, sends hello alone, and reads frames from the byte after its reply. Calls made
   * meanwhile reject with "hello negotiation in progress" and write nothing. An error reply leaves
   * the connection plain.
   */
  async hello({ framed }: { framed: boolean } = { framed: true }): Promise<HcResult<"hello">> {
    if (this.mode === "framed" && !this.ended) throw new Error("hello already completed");
    const refused = this.refusal();
    if (refused) throw refused;
    return this.transition(
      ["hello-draining", "hello-pending"],
      "hello",
      { generation: HC_PROTOCOL_GENERATION, framed },
      (result, resolve, reject) => this.completeHello(result, framed, resolve, reject),
    );
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
   * Throws the first error `handler` threw on a replayed frame, once all of them are replayed.
   */
  routeChannel(channel: number, handler: ChannelHandler): () => void {
    if (this.ended) return () => {};
    const failure = this.routeAndReplay(channel, handler);
    if (failure !== undefined) throw failure;
    return () => {
      if (this.channels.get(channel) === handler) this.releaseChannel(channel);
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
    for (const attachment of this.attachments.values()) attachment.transportEnded(cause);
    this.attachments.clear();
    for (const subscription of this.subscriptions.values()) subscription.transportEnded(cause);
    this.subscriptions.clear();
    this.plainSubscription?.transportEnded(cause);
    this.plainSubscription = undefined;
    this.listeners.clear();
    this.channels.clear();
    this.stashed.clear();
    this.inbound = [];
    this.notifyDrained();
    this.resolveClosed(cause);
  }

  /** Why a call can't be sent now, or undefined when it can. */
  private refusal(): Error | undefined {
    if (this.ended) return new TransportClosedError(this.endCause);
    if (this.mode === "hello-draining" || this.mode === "hello-pending") {
      return new Error(HELLO_IN_PROGRESS);
    }
    if (this.mode === "subscribe-draining" || this.mode === "subscribe-pending") {
      return new Error(SUBSCRIBE_IN_PROGRESS);
    }
    if (this.mode === "notifications") return new Error(NOTIFICATIONS_ONLY);
    return undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const refused = this.refusal();
    if (refused) return Promise.reject(refused);
    return new Promise((resolve, reject) => this.send(method, params, { resolve, reject }));
  }

  /** Encodes, registers and queues one request. Throws, registering nothing, if it can't encode. */
  private send(method: string, params: unknown, call: PendingCall): void {
    const id = this.nextId++;
    const bytes = this.encodeMessage({ jsonrpc: "2.0", id, method, params });
    this.pending.set(id, call);
    this.enqueue(bytes, (error) => this.failCall(id, error)).catch(() => {
      // The call settles through `pending`; this write promise has no other reader.
    });
  }

  /**
   * Sends a call that changes what the connection carries. Calls are refused from now on; this
   * one waits for those already accepted and goes out alone. `complete` sees its result before
   * any later input is read. A failed call puts the connection back to plain.
   */
  private async transition<T>(
    [draining, waiting]: [Mode, Mode],
    method: string,
    params: unknown,
    complete: (
      result: unknown,
      resolve: (value: T) => void,
      reject: (error: unknown) => void,
    ) => unknown,
  ): Promise<T> {
    this.mode = draining;
    await this.drained();
    if (this.ended) throw new TransportClosedError(this.endCause);
    this.mode = waiting;
    return new Promise<T>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (!this.ended) this.mode = "plain";
        reject(error);
      };
      try {
        this.send(method, params, {
          resolve: (result) => complete(result, resolve, fail),
          reject: fail,
        });
      } catch (error) {
        fail(error);
      }
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
      reject(new Error("the core did not switch to framed mode"));
      return;
    }
    // Switch before anyone sees the result, so the bytes after the reply are read as frames.
    this.mode = framed ? "framed" : "plain";
    resolve(result as unknown as HcResult<"hello">);
  }

  /**
   * Installs a subscription from its reply, before any later input is read: a plain one takes
   * over the connection's notifications, a framed one its channel and the frames kept for it.
   * Returns the first error a callback threw.
   */
  private startSubscription(
    result: unknown,
    framed: boolean,
    callbacks: SubscribeCallbacks,
    resolve: (subscription: EventSubscription) => void,
    reject: (error: unknown) => void,
  ): unknown {
    const reply = isRecord(result) ? result : {};
    const { seq, terminals, channel } = reply;
    if (
      typeof seq !== "number" ||
      !Array.isArray(terminals) ||
      (framed ? !isChannel(channel) : channel !== undefined && channel !== null)
    ) {
      const error = new ProtocolError("invalid events.subscribe result");
      reject(error);
      this.end(error);
      return undefined;
    }
    const snapshot = { seq, terminals } as EventSnapshot;
    const subscription = new Subscription(
      {
        send: (kind, payload, valid) =>
          this.enqueueFrame({ channel: channel as number, kind, payload }, valid),
        release: () => this.releaseChannel(channel as number),
        requestTransportClose: this.requestTransportClose,
      },
      framed ? (channel as number) : undefined,
      snapshot,
      callbacks,
    );
    if (framed) {
      this.subscriptions.set(channel as number, subscription);
    } else {
      this.plainSubscription = subscription;
      this.mode = "notifications";
    }
    resolve(subscription);
    const failure = subscription.start();
    if (!framed) return failure;
    const replayed = this.routeAndReplay(channel as number, (frame) => {
      const error = subscription.receive(frame);
      if (error !== undefined) throw error;
    });
    return failure === undefined ? replayed : failure;
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

  private enqueue(
    bytes: Uint8Array,
    onError?: (error: unknown) => void,
    valid?: () => boolean,
  ): Promise<void> {
    if (this.ended) return Promise.reject(new TransportClosedError(this.endCause));
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, epoch: this.epoch, resolve, reject, onError, valid });
      this.pump();
    });
  }

  private enqueueFrame(frame: Frame, valid: () => boolean): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(bytes, undefined, valid);
  }

  /** Routes `channel` and replays the frames kept for it. Returns the first handler error. */
  private routeAndReplay(channel: number, handler: ChannelHandler): unknown {
    this.channels.set(channel, handler);
    const early = this.stashed.get(channel);
    this.stashed.delete(channel);
    let failure: unknown;
    for (const frame of early?.frames ?? []) {
      const error = this.route(frame);
      if (failure === undefined) failure = error;
    }
    return failure;
  }

  private releaseChannel(channel: number): void {
    this.channels.delete(channel);
    this.attachments.delete(channel);
    this.subscriptions.delete(channel);
    this.stashed.delete(channel);
    this.closedChannels.add(channel);
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
        if (job.valid && !job.valid()) {
          job.reject(new StreamClosedError());
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

  /** Hands a stream frame to its channel's handler, or keeps it. A ProtocolError ends the connection. */
  private route(frame: Frame): unknown {
    if (this.closedChannels.has(frame.channel)) return undefined;
    const handler = this.channels.get(frame.channel);
    if (handler) {
      try {
        handler(frame);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
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
    return isRequest ? undefined : this.settle(message);
  }

  /** Settles a reply's call. Returns a listener error from the call's result hook. */
  private settle(message: Record<string, unknown>): unknown {
    const id = message.id;
    if (typeof id !== "number") return undefined;
    const call = this.pending.get(id);
    if (!call) return undefined;
    this.pending.delete(id);
    const hasResult = "result" in message;
    const hasError = "error" in message;
    const error = message.error;
    let failure: unknown;
    if (hasResult && !hasError) {
      failure = call.resolve(message.result);
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
    return failure;
  }

  private notify(notification: JsonRpcNotification): unknown {
    let failure = this.plainSubscription?.notify(notification);
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
