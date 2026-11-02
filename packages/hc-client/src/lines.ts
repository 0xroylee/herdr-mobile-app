// Newline-delimited input, following vs-streamjsonrpc's NewLineDelimitedMessageHandler: keep an
// incomplete line until its LF arrives, accept LF or CRLF, and report how many bytes each line used.

import { MAX_FRAME_PAYLOAD } from "@herdr-mobile/protocol";
import { ProtocolError } from "./errors.ts";

const LF = 10;
const CR = 13;

export interface Line {
  /** The line without its LF or CRLF. */
  line: Uint8Array;
  /** Bytes taken from the input, delimiter included. */
  consumed: number;
}

export class LineDecoder {
  private buffer = new Uint8Array(1024);
  private start = 0;
  private end = 0;
  /** Bytes after `start` already searched without finding LF. */
  private scanned = 0;

  push(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.end);
    this.end += bytes.length;
  }

  takeLine(): Line | undefined {
    const from = this.start + this.scanned;
    const found = this.buffer.subarray(from, this.end).indexOf(LF);
    if (found < 0) {
      this.scanned = this.end - this.start;
      if (this.scanned > MAX_FRAME_PAYLOAD) {
        throw new ProtocolError(`line of more than ${MAX_FRAME_PAYLOAD} bytes without a newline`);
      }
      return undefined;
    }
    const lf = from + found;
    const lineEnd = lf > this.start && this.buffer[lf - 1] === CR ? lf - 1 : lf;
    const line = this.buffer.slice(this.start, lineEnd);
    const consumed = lf + 1 - this.start;
    this.start = lf + 1;
    this.scanned = 0;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
    return { line, consumed };
  }

  /** Removes and returns everything not yet taken as a line. */
  drain(): Uint8Array {
    const rest = this.buffer.slice(this.start, this.end);
    this.start = 0;
    this.end = 0;
    this.scanned = 0;
    return rest;
  }

  get buffered(): number {
    return this.end - this.start;
  }

  private reserve(extra: number): void {
    if (this.end + extra <= this.buffer.length) return;
    const used = this.end - this.start;
    if (used + extra <= this.buffer.length) {
      this.buffer.copyWithin(0, this.start, this.end);
    } else {
      let capacity = this.buffer.length;
      while (capacity < used + extra) capacity *= 2;
      const next = new Uint8Array(capacity);
      next.set(this.buffer.subarray(this.start, this.end));
      this.buffer = next;
    }
    this.start = 0;
    this.end = used;
  }
}
