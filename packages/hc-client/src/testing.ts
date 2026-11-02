// Helpers shared by the hc-client tests. Nothing the client exports imports this file.

import { FrameKind } from "@herdr-mobile/protocol";
import { createClient } from "./client.ts";
import { encodeFrame } from "./frame.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

export type Message = Record<string, unknown>;

export const line = (message: unknown) => utf8Encode(`${JSON.stringify(message)}\n`);
export const lines = (...messages: unknown[]) =>
  utf8Encode(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
export const decode = (bytes: Uint8Array) => JSON.parse(utf8Decode(bytes)) as Message;
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One DATA frame on `channel`. */
export const dataFrame = (channel: number, payload: Uint8Array) =>
  encodeFrame({ channel, kind: FrameKind.Data, payload });

/** One JSON-RPC message as a channel-0 DATA frame. */
export const frame = (message: unknown) => dataFrame(0, utf8Encode(JSON.stringify(message)));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records how a promise settles without awaiting it. */
export function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

/** A client whose writes are captured. `requests` reads them as plain JSON lines. */
export function capture() {
  const writes: Uint8Array[] = [];
  const client = createClient({
    write: (bytes) => {
      writes.push(bytes);
    },
  });
  return { client, writes, requests: () => writes.map(decode) };
}
