// One events.subscribe stream. Framed, its events are JSON lines on the reply's channel, credited
// as they are read; plain, they are the connection's own notifications once the reply is in.
// Either way the snapshot comes first, an event not above the current snapshot's seq is dropped,
// `missed` replaces the snapshot, and `heartbeat` is reported on its own.

import {
  type Frame,
  FrameKind,
  type HcEvent,
  type JsonRpcNotification,
  type SubscribeResult,
} from "@herdr-mobile/protocol";
import { closeReason, type StreamEnd } from "./attach.ts";
import { ProtocolError, TransportClosedError } from "./errors.ts";
import { encodeCredit } from "./frame.ts";
import { isPromiseLike, isRecord } from "./guards.ts";
import { LineDecoder } from "./lines.ts";
import { utf8Decode } from "./utf8.ts";

/** Matching terminals, and the seq they are current at. */
export type EventSnapshot = Omit<SubscribeResult, "channel">;

export interface SubscribeCallbacks {
  /** The first snapshot, then each one a `missed` brings: it replaces everything before it. */
  onSnapshot?(snapshot: EventSnapshot): void;
  /** Each event newer than the current snapshot, in order. Gaps in seq are other terminals'. */
  onEvent?(event: HcEvent): void;
  /** The core's `heartbeat`, every 15 s, with its current seq. */
  onHeartbeat?(seq: number): void;
}

export interface EventSubscription {
  /** The framed channel; undefined on a plain connection. */
  readonly channel: number | undefined;
  /** The current snapshot. */
  readonly snapshot: EventSnapshot;
  /** Settles once, with how the stream ended. */
  readonly closed: Promise<StreamEnd>;
  /**
   * Framed: sends CLOSE and waits for the core's. Plain: asks the caller to close its transport
   * through `requestTransportClose`, and waits for the caller's end().
   */
  close(): Promise<void>;
}

/** What a subscription needs from its connection. */
export interface SubscriptionLink {
  /** Framed: queues one frame on the channel. `valid` is asked again when its turn comes. */
  send(kind: number, payload: Uint8Array, valid: () => boolean): Promise<void>;
  /** Framed: stops routing the channel. */
  release(): void;
  /** Plain: the caller's hook that closes its transport. */
  requestTransportClose: (() => void | Promise<void>) | undefined;
}

const PLAIN_CLOSE_NEEDS_TRANSPORT = "plain subscription close requires transport closure";

interface Pending {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function pending(): Pending {
  let settle: Omit<Pending, "promise"> = { resolve: () => {}, reject: () => {} };
  const promise = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/** Runs one callback. Returns what it threw. */
function attempt(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A subscription as its connection sees it: `start`, `receive`, `notify` and `transportEnded`. */
export class Subscription implements EventSubscription {
  readonly channel: number | undefined;
  readonly closed: Promise<StreamEnd>;
  private current: EventSnapshot;
  /** Events at or below this seq are in the snapshot or already delivered. */
  private baseline: number;
  private readonly link: SubscriptionLink;
  private readonly callbacks: SubscribeCallbacks;
  /** A framed channel's unfinished line. */
  private readonly lines = new LineDecoder();
  private phase: "open" | "closing" | "closed" = "open";
  private closing: Pending | undefined;
  private resolveClosed: (end: StreamEnd) => void = () => {};

  constructor(
    link: SubscriptionLink,
    channel: number | undefined,
    snapshot: EventSnapshot,
    callbacks: SubscribeCallbacks,
  ) {
    this.link = link;
    this.channel = channel;
    this.current = snapshot;
    this.baseline = snapshot.seq;
    this.callbacks = callbacks;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get snapshot(): EventSnapshot {
    return this.current;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing.promise;
    if (this.phase === "closed") return Promise.resolve();
    if (this.channel === undefined) return this.closePlain();
    const closing = pending();
    this.closing = closing;
    this.phase = "closing";
    this.link
      .send(FrameKind.Close, new Uint8Array(0), () => this.phase === "closing")
      .catch(() => {
        // The stream then ends another way, and that settles the close.
      });
    return closing.promise;
  }

  /** Hands the first snapshot to onSnapshot. Returns what the callback threw. */
  start(): unknown {
    return attempt(() => this.callbacks.onSnapshot?.(this.current));
  }

  /** One frame from the framed channel. Returns the first error a callback threw. */
  receive(frame: Frame): unknown {
    if (this.phase === "closed") return undefined;
    if (frame.kind === FrameKind.Close) {
      this.finish(
        frame.payload.length === 0
          ? { kind: "detached" }
          : { kind: "program", reason: closeReason(frame.payload) },
      );
      return undefined;
    }
    if (frame.kind !== FrameKind.Data) return undefined;
    this.lines.push(frame.payload);
    let failure: unknown;
    for (let line = this.lines.takeLine(); line; line = this.lines.takeLine()) {
      const notification = parseLine(line.line);
      const error = notification && this.notify(notification);
      if (failure === undefined) failure = error;
    }
    // These bytes are read: the core may send that much more.
    if (this.phase === "open") {
      this.link
        .send(FrameKind.Credit, encodeCredit(frame.payload.length), () => this.phase === "open")
        .catch(() => {
          // Credit for a stream that has ended no longer matters.
        });
    }
    return failure;
  }

  /** One notification for this subscription. Returns what a callback threw. */
  notify(notification: JsonRpcNotification): unknown {
    if (this.phase === "closed") return undefined;
    const params = isRecord(notification.params) ? notification.params : {};
    const seq = params.seq;
    if (typeof seq !== "number") return undefined;
    if (notification.method === "event") {
      if (seq <= this.baseline) return undefined;
      this.baseline = seq;
      return attempt(() => this.callbacks.onEvent?.(params as unknown as HcEvent));
    }
    if (notification.method === "missed") {
      const terminals = Array.isArray(params.terminals) ? params.terminals : [];
      this.current = { seq, terminals } as unknown as EventSnapshot;
      this.baseline = seq;
      return attempt(() => this.callbacks.onSnapshot?.(this.current));
    }
    if (notification.method === "heartbeat") {
      return attempt(() => this.callbacks.onHeartbeat?.(seq));
    }
    return undefined;
  }

  /** The connection ended. After a plain close() asked for it, a clean end is that close. */
  transportEnded(cause: unknown): void {
    if (this.phase === "closed") return;
    const closedByRequest =
      this.channel === undefined && this.closing !== undefined && cause === undefined;
    this.phase = "closed";
    this.resolveClosed(closedByRequest ? { kind: "detached" } : { kind: "transport", cause });
    if (closedByRequest) this.closing?.resolve();
    else this.closing?.reject(new TransportClosedError(cause));
  }

  private closePlain(): Promise<void> {
    const request = this.link.requestTransportClose;
    if (!request) return Promise.reject(new Error(PLAIN_CLOSE_NEEDS_TRANSPORT));
    const closing = pending();
    this.closing = closing;
    const failed = (error: unknown) => {
      if (this.closing !== closing || this.phase === "closed") return;
      this.closing = undefined;
      closing.reject(error);
    };
    try {
      const result = request();
      if (isPromiseLike(result)) result.then(undefined, failed);
    } catch (error) {
      failed(error);
    }
    return closing.promise;
  }

  private finish(end: StreamEnd): void {
    this.phase = "closed";
    this.link.release();
    this.resolveClosed(end);
    this.closing?.resolve();
  }
}

function parseLine(bytes: Uint8Array): JsonRpcNotification | undefined {
  const text = utf8Decode(bytes);
  if (text.trim() === "") return undefined;
  try {
    const message: unknown = JSON.parse(text);
    if (isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string") {
      return message as unknown as JsonRpcNotification;
    }
  } catch {
    // Reported below.
  }
  throw new ProtocolError(`invalid event line from the core: ${text.slice(0, 120)}`);
}
