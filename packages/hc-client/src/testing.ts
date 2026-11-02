// Helpers shared by the hc-client tests. Nothing the client exports imports this file.

import {
  type Frame,
  FrameKind,
  type HelloResult,
  INITIAL_STREAM_CREDIT,
  type JsonValue,
  type Terminal,
} from "@herdr-mobile/protocol";
import type { AttachHandle } from "./attach.ts";
import { createClient, type HcClient } from "./client.ts";
import { decodeCredit, encodeFrame, FrameDecoder } from "./frame.ts";
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

/** hc 0.1.16's hello reply as research.md records it, with the method list cut short. */
export const HC_0_1_16: HelloResult = {
  generation: 1,
  version: "0.1.16",
  core: { id: "0f3c9a2e", name: "agent-mac" },
  framed: true,
  methods: ["hello", "terminal.list", "terminal.attach", "events.subscribe", "doc.get"],
  features: ["framed", "attach", "events", "status", "shell"],
};

/** The terminal record a fake attach reply carries: only what the tests look at. */
export const terminalRecord = (id: string) => ({ id, name: id }) as unknown as Terminal;

/** wire.rs sends stream output in chunks of at most 16 KiB. */
const CHUNK = 16 * 1024;

interface FakeStream {
  credit: number;
  /** Output not sent yet, oldest first. */
  pending: Uint8Array[];
  /** The program ended: CLOSE with this payload once `pending` is out. */
  ending: Uint8Array | undefined;
}

/**
 * herdr-core on one framed connection, after wire.rs's Outbox: it answers hello,
 * terminal.attach and events.subscribe, sends stream output only as far as the reader's credit
 * allows, ends a stream with CLOSE only once its output is out, and answers a client's CLOSE
 * with an empty one. It records every frame the client writes, and sends what it has in one read:
 * to its own `client`, or to `deliver` when one is given, as `hc connect`'s stdout would.
 */
export class FakeCore {
  readonly client: HcClient;
  /** Frames the client wrote after hello, in order. */
  readonly received: Frame[] = [];
  /** The next attach's first paint. */
  paint: Uint8Array = utf8Encode("\u001b[?9001l\u001b[H\u001b[2Jpaint|");
  /** Send the first paint ahead of the attach reply, as the core may. */
  paintFirst = false;
  /** What the next events.subscribe answers, before its channel is added. */
  snapshot: { seq: number; terminals: Terminal[] } = { seq: 10, terminals: [] };
  /** Event lines a new subscription's channel carries ahead of its reply. */
  early: Uint8Array = new Uint8Array(0);
  /** Answer a client's CLOSE. */
  answerClose = true;
  /** An error to answer hello with, instead of hc 0.1.16's result. */
  helloError: object | undefined;
  /** Each events.subscribe's params, in order. */
  readonly subscribed: unknown[] = [];
  /** The method of every call it received, hello included, in order. */
  readonly calls: string[] = [];
  /** The channels it opened, by what opened them. */
  readonly opened: { attach: number[]; subscribe: number[] } = { attach: [], subscribe: [] };
  /** Answers other methods: a result, or undefined for a not_found error. */
  answer: (method: string, params: Record<string, unknown>) => unknown = () => undefined;
  private readonly held = new Map<string, { request: Message; plain: boolean }[]>();
  private readonly sink: (bytes: Uint8Array) => void;
  private readonly decoder = new FrameDecoder();
  private readonly streams = new Map<number, FakeStream>();
  private outbox: Uint8Array[] = [];
  private nextChannel = 0;
  /** Plain until it answers a hello that asked for framing. */
  private framed = false;
  private gate: Promise<void> | undefined;

  constructor(deliver?: (bytes: Uint8Array) => void) {
    this.client = createClient({ write: (bytes) => this.write(bytes) });
    this.sink = deliver ?? ((bytes) => this.client.feed(bytes));
  }

  async open(): Promise<void> {
    await this.client.hello();
  }

  attach(
    terminal: string,
    onData: (bytes: Uint8Array) => void,
    extra: { observe?: boolean } = {},
  ): Promise<AttachHandle> {
    return this.client.attach({ terminal, cols: 80, rows: 24, ...extra }, { onData });
  }

  /** Makes the next write wait until the returned function runs. */
  holdNextWrite(): () => void {
    const gate = deferred();
    this.gate = gate.promise;
    return () => gate.resolve();
  }

  /** Program output on `channel`, sent as credit allows. */
  output(channel: number, bytes: Uint8Array): void {
    this.streams.get(channel)?.pending.push(bytes);
    this.pump(channel);
    this.deliver();
  }

  /** The program ended: CLOSE with `reason` once its output is out. */
  finish(channel: number, reason: JsonValue): void {
    const stream = this.streams.get(channel);
    if (stream) stream.ending = utf8Encode(JSON.stringify(reason));
    this.pump(channel);
    this.deliver();
  }

  /** Sends one frame now, whatever the credit. */
  send(frame: Frame): void {
    this.outbox.push(encodeFrame(frame));
    this.deliver();
  }

  /** Frames the client wrote on `channel` with `kind`. */
  frames(channel: number, kind: number): Frame[] {
    return this.received.filter((f) => f.channel === channel && f.kind === kind);
  }

  credits(channel: number): number[] {
    return this.frames(channel, FrameKind.Credit).map((f) => decodeCredit(f.payload));
  }

  /** Leaves calls to `method` unanswered until release(). */
  hold(method: string): void {
    this.held.set(method, this.held.get(method) ?? []);
  }

  /** Answers the held calls to `method`, and those that follow. */
  release(method: string): void {
    const requests = this.held.get(method) ?? [];
    this.held.delete(method);
    for (const { request, plain } of requests) this.respond(request, plain);
    this.deliver();
  }

  /** Takes bytes the client wrote. */
  write(bytes: Uint8Array): void | Promise<void> {
    if (!this.framed) {
      for (const text of utf8Decode(bytes).split("\n")) {
        if (text.trim() !== "") this.rpc(JSON.parse(text) as Message, true);
      }
    } else {
      for (const received of this.decoder.push(bytes)) this.handle(received);
    }
    this.deliver();
    const gate = this.gate;
    this.gate = undefined;
    return gate;
  }

  private handle(received: Frame): void {
    this.received.push(received);
    if (received.channel === 0) {
      this.rpc(decode(received.payload));
      return;
    }
    const stream = this.streams.get(received.channel);
    if (!stream) return;
    if (received.kind === FrameKind.Credit) {
      stream.credit += decodeCredit(received.payload);
      this.pump(received.channel);
    } else if (received.kind === FrameKind.Close && this.answerClose) {
      this.streams.delete(received.channel);
      this.outbox.push(
        encodeFrame({
          channel: received.channel,
          kind: FrameKind.Close,
          payload: new Uint8Array(0),
        }),
      );
    }
  }

  private rpc(request: Message, plain = false): void {
    const method = String(request.method);
    this.calls.push(method);
    const held = this.held.get(method);
    if (held) held.push({ request, plain });
    else this.respond(request, plain);
  }

  private respond(request: Message, plain: boolean): void {
    const method = String(request.method);
    const answer = (message: object) => {
      this.outbox.push(plain ? line(message) : frame(message));
    };
    if (method === "hello" && this.helloError) {
      answer({ jsonrpc: "2.0", id: request.id, error: this.helloError });
      return;
    }
    if (method === "hello") {
      answer({ jsonrpc: "2.0", id: request.id, result: HC_0_1_16 });
      if ((request.params as { framed?: boolean } | undefined)?.framed === true) this.framed = true;
      return;
    }
    if (request.method === "events.subscribe") {
      this.subscribed.push(request.params);
      const channel = this.openStream(this.early);
      this.opened.subscribe.push(channel);
      this.pump(channel);
      const result = { ...this.snapshot, channel };
      this.outbox.push(frame({ jsonrpc: "2.0", id: request.id, result }));
      return;
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    const terminal = String(params.terminal);
    const answered = method === "terminal.attach" ? undefined : this.answer(method, params);
    if (answered !== undefined) {
      answer({ jsonrpc: "2.0", id: request.id, result: answered });
      return;
    }
    if (request.method !== "terminal.attach" || terminal.startsWith("missing")) {
      const error = {
        code: -32000,
        message: `no terminal ${terminal}`,
        data: { kind: "not_found" },
      };
      answer({ jsonrpc: "2.0", id: request.id, error });
      return;
    }
    const channel = this.openStream(this.paint);
    this.opened.attach.push(channel);
    const result = { channel, terminal: terminalRecord(terminal) };
    const reply = frame({ jsonrpc: "2.0", id: request.id, result });
    if (!this.paintFirst) this.outbox.push(reply);
    this.pump(channel);
    if (this.paintFirst) this.outbox.push(reply);
  }

  private openStream(first: Uint8Array): number {
    const channel = ++this.nextChannel;
    const pending = first.length > 0 ? [first] : [];
    this.streams.set(channel, { credit: INITIAL_STREAM_CREDIT, pending, ending: undefined });
    return channel;
  }

  private pump(channel: number): void {
    const stream = this.streams.get(channel);
    if (!stream) return;
    while (stream.credit > 0 && stream.pending.length > 0) {
      const head = stream.pending[0] as Uint8Array;
      const size = Math.min(head.length, stream.credit, CHUNK);
      this.outbox.push(dataFrame(channel, head.subarray(0, size)));
      stream.credit -= size;
      if (size === head.length) stream.pending.shift();
      else stream.pending[0] = head.subarray(size);
    }
    if (stream.ending && stream.pending.length === 0) {
      this.outbox.push(encodeFrame({ channel, kind: FrameKind.Close, payload: stream.ending }));
      this.streams.delete(channel);
    }
  }

  private deliver(): void {
    if (this.outbox.length === 0) return;
    const bytes = concat(...this.outbox);
    this.outbox = [];
    this.sink(bytes);
  }
}
