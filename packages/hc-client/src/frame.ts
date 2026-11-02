// Framed-mode codec, following herdr-core's wire.rs: [channel u32 LE][kind u8][len u32 LE][payload].
// The decoder validates each header before it asks for payload storage, and keeps partial
// headers and payloads across any number of reads.

import {
  FRAME_HEADER_BYTES,
  type Frame,
  type JsonValue,
  MAX_FRAME_PAYLOAD,
} from "@herdr-mobile/protocol";
import { utf8Decode, utf8Encode } from "./utf8.ts";

/** A frame that breaks the wire contract. The connection can't continue after one. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** Returns storage for one payload of exactly `byteLength` bytes. */
export type PayloadAllocator = (byteLength: number) => Uint8Array;

export interface FrameDecoderOptions {
  /** Test seam for observing payload allocation. Production uses `new Uint8Array`. */
  allocatePayload?: PayloadAllocator;
}

function oversized(byteLength: number): FrameError {
  return new FrameError(`frame of ${byteLength} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const { channel, kind, payload } = frame;
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) {
    throw new FrameError(`frame channel ${channel} is not a u32`);
  }
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) {
    throw new FrameError(`frame kind ${kind} is not a u8`);
  }
  if (payload.byteLength > MAX_FRAME_PAYLOAD) throw oversized(payload.byteLength);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, channel, true);
  view.setUint8(4, kind);
  view.setUint32(5, payload.byteLength, true);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export class FrameDecoder {
  private readonly allocate: PayloadAllocator;
  private readonly header = new Uint8Array(FRAME_HEADER_BYTES);
  private headerFilled = 0;
  private channel = 0;
  private kind = 0;
  private payload: Uint8Array | undefined;
  private payloadFilled = 0;
  private failure: FrameError | undefined;

  constructor(options: FrameDecoderOptions = {}) {
    this.allocate = options.allocatePayload ?? ((byteLength) => new Uint8Array(byteLength));
  }

  /** Feeds bytes from one read and returns every frame they complete, in order. */
  push(bytes: Uint8Array): Frame[] {
    if (this.failure) throw this.failure;
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.payload === undefined) {
        const take = Math.min(FRAME_HEADER_BYTES - this.headerFilled, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + take), this.headerFilled);
        this.headerFilled += take;
        offset += take;
        if (this.headerFilled < FRAME_HEADER_BYTES) break;
        this.startPayload();
      }
      const payload = this.payload as Uint8Array;
      const take = Math.min(payload.length - this.payloadFilled, bytes.length - offset);
      payload.set(bytes.subarray(offset, offset + take), this.payloadFilled);
      this.payloadFilled += take;
      offset += take;
      if (this.payloadFilled === payload.length) {
        frames.push({ channel: this.channel, kind: this.kind, payload });
        this.payload = undefined;
      }
    }
    return frames;
  }

  /** Call when the stream ends. Throws if a frame was cut off. */
  finish(): void {
    if (this.failure) throw this.failure;
    if (this.headerFilled > 0) {
      throw new FrameError(
        `truncated frame header: ${this.headerFilled} of ${FRAME_HEADER_BYTES} bytes`,
      );
    }
    if (this.payload !== undefined) {
      throw new FrameError(
        `truncated frame payload: ${this.payloadFilled} of ${this.payload.length} bytes`,
      );
    }
  }

  private startPayload(): void {
    const view = new DataView(this.header.buffer, this.header.byteOffset, FRAME_HEADER_BYTES);
    const length = view.getUint32(5, true);
    if (length > MAX_FRAME_PAYLOAD) {
      this.failure = oversized(length);
      throw this.failure;
    }
    const payload = this.allocate(length);
    if (payload.length !== length) {
      this.failure = new FrameError(
        `payload allocator returned ${payload.length} bytes for ${length}`,
      );
      throw this.failure;
    }
    this.channel = view.getUint32(0, true);
    this.kind = view.getUint8(4);
    this.payload = payload;
    this.payloadFilled = 0;
    this.headerFilled = 0;
  }
}

function expectLength(payload: Uint8Array, length: number, what: string): DataView {
  if (payload.length !== length) {
    throw new FrameError(`${what} payload has ${payload.length} bytes, expected ${length}`);
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

function expectUint(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new FrameError(`${what} ${value} is out of range 0..${max}`);
  }
}

export function encodeCredit(bytes: number): Uint8Array {
  expectUint(bytes, 0xffffffff, "credit");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, bytes, true);
  return out;
}

export function decodeCredit(payload: Uint8Array): number {
  return expectLength(payload, 4, "CREDIT").getUint32(0, true);
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  expectUint(cols, 0xffff, "cols");
  expectUint(rows, 0xffff, "rows");
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint16(0, cols, true);
  view.setUint16(2, rows, true);
  return out;
}

export function decodeResize(payload: Uint8Array): { cols: number; rows: number } {
  const view = expectLength(payload, 4, "RESIZE");
  return { cols: view.getUint16(0, true), rows: view.getUint16(2, true) };
}

export function encodeFocus(gained: boolean): Uint8Array {
  return Uint8Array.of(gained ? 1 : 0);
}

export function decodeFocus(payload: Uint8Array): boolean {
  const value = expectLength(payload, 1, "FOCUS").getUint8(0);
  if (value > 1) throw new FrameError(`FOCUS payload ${value} is neither 0 nor 1`);
  return value === 1;
}

/** An empty CLOSE ends a channel from the client side; the core's carries a JSON reason. */
export function encodeClose(reason?: JsonValue): Uint8Array {
  return reason === undefined ? new Uint8Array(0) : utf8Encode(JSON.stringify(reason));
}

export function decodeClose(payload: Uint8Array): JsonValue | undefined {
  return payload.length === 0 ? undefined : (JSON.parse(utf8Decode(payload)) as JsonValue);
}

export function encodeFacts(display: JsonValue): Uint8Array {
  return utf8Encode(JSON.stringify(display));
}

export function decodeFacts(payload: Uint8Array): JsonValue {
  return JSON.parse(utf8Decode(payload)) as JsonValue;
}
