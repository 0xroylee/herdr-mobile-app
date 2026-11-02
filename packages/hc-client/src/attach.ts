// One terminal attachment on a framed connection, following the viewer in herdr-core's
// tests/common/framed.rs: frames are routed by channel, the caller renders DATA, and only bytes
// it reports as consumed go back as CREDIT. The core opens each stream with 256 KiB of credit.

import {
  type Display,
  type Frame,
  FrameKind,
  type JsonValue,
  type Terminal,
} from "@herdr-mobile/protocol";
import { StreamClosedError, TransportClosedError } from "./errors.ts";
import { decodeClose, encodeCredit, encodeFacts, encodeFocus, encodeResize } from "./frame.ts";
import { utf8Decode } from "./utf8.ts";

/** How a stream ended. */
export type StreamEnd =
  /** The core acknowledged a detach with an empty CLOSE. */
  | { kind: "detached" }
  /** The core closed the stream with a reason, exactly as it sent it. */
  | { kind: "program"; reason: JsonValue }
  /** The connection ended first. */
  | { kind: "transport"; cause?: unknown };

export interface AttachOptions {
  /**
   * Gets each DATA payload unchanged: the first paint, live output and repaints. Call
   * `consume` with the byte count once they are rendered; that is what returns credit.
   */
  onData(bytes: Uint8Array): void;
}

export interface AttachHandle {
  readonly channel: number;
  readonly terminal: Terminal;
  readonly observe: boolean;
  /** Settles once, with how the stream ended. */
  readonly closed: Promise<StreamEnd>;
  /** Returns `byteCount` rendered bytes to the core as CREDIT. Does nothing once closed. */
  consume(byteCount: number): void;
  /** Sends keys as DATA. The bytes go out as given: the core never encodes keys. */
  writeInput(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  focus(gained: boolean): Promise<void>;
  facts(display: Display): Promise<void>;
  /** Sends CLOSE and settles with the core's answer: an empty CLOSE, or the program's end. */
  detach(): Promise<StreamEnd>;
}

/** What an attachment needs from its connection. */
export interface StreamLink {
  /** Queues one frame on the stream's channel. `valid` is asked again when its turn comes. */
  send(kind: number, payload: Uint8Array, valid: () => boolean): Promise<void>;
  /** Stops routing the channel. Its late frames are dropped: the core never reuses a channel. */
  release(): void;
}

export const OBSERVE_ONLY = "observe attachment cannot type or resize";

interface PendingDetach {
  resolve(end: StreamEnd): void;
  reject(error: unknown): void;
}

/** An attachment as its connection sees it: `receive` and `transportEnded` are for the client. */
export class Attachment implements AttachHandle {
  readonly channel: number;
  readonly terminal: Terminal;
  readonly observe: boolean;
  readonly closed: Promise<StreamEnd>;
  private readonly link: StreamLink;
  private readonly onData: (bytes: Uint8Array) => void;
  private phase: "open" | "detaching" | "closed" = "open";
  private outcome: StreamEnd | undefined;
  /** Bytes delivered to onData and not consumed yet. */
  private unconsumed = 0;
  private detaching: { promise: Promise<StreamEnd>; settle: PendingDetach } | undefined;
  private resolveClosed: (end: StreamEnd) => void = () => {};

  constructor(
    link: StreamLink,
    channel: number,
    terminal: Terminal,
    observe: boolean,
    options: AttachOptions,
  ) {
    this.link = link;
    this.channel = channel;
    this.terminal = terminal;
    this.observe = observe;
    this.onData = options.onData;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  consume(byteCount: number): void {
    if (this.phase !== "open") return;
    if (!Number.isInteger(byteCount) || byteCount < 0 || byteCount > this.unconsumed) {
      throw new RangeError(`consumed ${byteCount} bytes with ${this.unconsumed} delivered`);
    }
    if (byteCount === 0) return;
    this.unconsumed -= byteCount;
    this.link
      .send(FrameKind.Credit, encodeCredit(byteCount), () => this.phase === "open")
      .catch(() => {
        // Credit for a stream that has ended no longer matters.
      });
  }

  writeInput(bytes: Uint8Array): Promise<void> {
    return this.control(FrameKind.Data, () => bytes, true);
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.control(FrameKind.Resize, () => encodeResize(cols, rows), true);
  }

  focus(gained: boolean): Promise<void> {
    return this.control(FrameKind.Focus, () => encodeFocus(gained), false);
  }

  facts(display: Display): Promise<void> {
    return this.control(FrameKind.Facts, () => encodeFacts(display as JsonValue), false);
  }

  detach(): Promise<StreamEnd> {
    if (this.outcome) return Promise.resolve(this.outcome);
    if (this.detaching) return this.detaching.promise;
    this.phase = "detaching";
    let settle: PendingDetach = { resolve: () => {}, reject: () => {} };
    const promise = new Promise<StreamEnd>((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.detaching = { promise, settle };
    this.link
      .send(FrameKind.Close, new Uint8Array(0), () => this.phase === "detaching")
      .catch(() => {
        // The stream then ends another way, and that settles the detach.
      });
    return promise;
  }

  receive(frame: Frame): void {
    if (this.phase === "closed") return;
    if (frame.kind === FrameKind.Data) {
      this.unconsumed += frame.payload.length;
      this.onData(frame.payload);
    } else if (frame.kind === FrameKind.Close) {
      this.finish(
        frame.payload.length === 0
          ? { kind: "detached" }
          : { kind: "program", reason: closeReason(frame.payload) },
      );
    }
  }

  transportEnded(cause: unknown): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.outcome = { kind: "transport", cause };
    this.resolveClosed(this.outcome);
    this.detaching?.settle.reject(new TransportClosedError(cause));
  }

  private control(kind: number, payload: () => Uint8Array, typesOrResizes: boolean): Promise<void> {
    if (this.phase !== "open") return Promise.reject(new StreamClosedError());
    if (typesOrResizes && this.observe) return Promise.reject(new Error(OBSERVE_ONLY));
    let bytes: Uint8Array;
    try {
      bytes = payload();
    } catch (error) {
      return Promise.reject(error);
    }
    // Input written before a detach still goes out ahead of its CLOSE.
    return this.link.send(kind, bytes, () => this.phase !== "closed");
  }

  private finish(end: StreamEnd): void {
    this.phase = "closed";
    this.outcome = end;
    this.link.release();
    this.resolveClosed(end);
    this.detaching?.settle.resolve(end);
  }
}

/** A non-empty CLOSE's reason as the core sent it. A payload that isn't JSON is kept as text. */
export function closeReason(payload: Uint8Array): JsonValue {
  try {
    return decodeClose(payload) as JsonValue;
  } catch {
    return utf8Decode(payload);
  }
}
