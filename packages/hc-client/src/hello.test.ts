import { describe, expect, test } from "bun:test";
import {
  type Frame,
  FrameKind,
  INITIAL_STREAM_CREDIT,
  type JsonRpcNotification,
  type ListResult,
} from "@herdr-mobile/protocol";
import { createClient, type HcClient } from "./client.ts";
import { HcRpcError, ProtocolError, TransportClosedError } from "./errors.ts";
import { encodeFrame, FrameDecoder } from "./frame.ts";
import {
  capture,
  concat,
  dataFrame,
  decode,
  deferred,
  flush,
  frame,
  HC_0_1_16,
  line,
  track,
} from "./testing.ts";
import { utf8Encode } from "./utf8.ts";

const LIST: ListResult = { terminals: [], hidden_finished: 0, machines: [] };
const IN_PROGRESS = "hello negotiation in progress";

const event = (seq: number): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: "event",
  params: { seq, type: "title", terminal: "t1", data: { title: `#${seq}` } },
});

/** Not valid UTF-8, with an LF and a CR in it: only a raw byte stream keeps these intact. */
const RAW = new Uint8Array([0xff, 0xfe, 0x00, 0x0a, 0x80, 0x0d, 0xc3, 0x28, 0x7b]);

function framesOf(writes: Uint8Array[]): Frame[] {
  const decoder = new FrameDecoder();
  return writes.flatMap((bytes) => decoder.push(bytes));
}

/** A client past hello, with its writes captured. */
async function framed() {
  const captured = capture();
  const hello = captured.client.hello();
  await flush();
  captured.client.feed(line({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 }));
  return { ...captured, hello: await hello };
}

describe("hello", () => {
  test("asks for generation 1 and framed mode on one plain line", async () => {
    const { client, writes, requests } = capture();
    void client.hello();
    await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.at(-1)).toBe(10);
    expect(requests()).toEqual([
      { jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1, framed: true } },
    ]);
  });

  test("hello({ framed: false }) checks the generation and leaves the connection plain", async () => {
    const { client, writes, requests } = capture();
    const hello = track(client.hello({ framed: false }));
    await flush();
    expect(requests()[0]?.params).toEqual({ generation: 1, framed: false });
    client.feed(line({ jsonrpc: "2.0", id: 1, result: { ...HC_0_1_16, framed: false } }));
    await flush();
    expect(hello.value).toEqual({ ...HC_0_1_16, framed: false });
    expect(client.isFramed).toBe(false);
    void client.call("terminal.list", {});
    expect(decode(writes[1] as Uint8Array).method).toBe("terminal.list");
  });

  test("an hc 0.1.16 reply makes a framed client whose calls are channel-0 DATA frames", async () => {
    const { client, writes, hello } = await framed();
    expect(hello).toEqual(HC_0_1_16);
    expect(client.isFramed).toBe(true);
    const call = client.call("terminal.list", {});
    expect(writes).toHaveLength(2);
    const sent = framesOf(writes.slice(1));
    expect(sent).toHaveLength(1);
    const request = sent[0] as Frame;
    expect([request.channel, request.kind]).toEqual([0, FrameKind.Data]);
    expect(writes[1]?.length).toBe(9 + request.payload.length);
    expect(decode(request.payload)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "terminal.list",
      params: {},
    });
    client.feed(frame({ jsonrpc: "2.0", id: 2, result: LIST }));
    expect(await call).toEqual(LIST);
  });

  test("waits for the calls already accepted before it sends hello", async () => {
    const { client, requests } = capture();
    const first = track(client.call("terminal.list", {}));
    const hello = track(client.hello());
    await flush();
    expect(requests().map((request) => request.method)).toEqual(["terminal.list"]);
    client.feed(line({ jsonrpc: "2.0", id: 1, result: LIST }));
    await flush();
    expect(first.value).toEqual(LIST);
    expect(requests().map((request) => request.method)).toEqual(["terminal.list", "hello"]);
    expect(hello.settled).toBe(false);
  });

  test("waits for a write still running, even when its reply is already in", async () => {
    const gate = deferred();
    const writes: Uint8Array[] = [];
    const client = createClient({
      write: (bytes) => {
        writes.push(bytes);
        return writes.length === 1 ? gate.promise : undefined;
      },
    });
    const first = client.call("terminal.list", {});
    void client.hello();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: LIST }));
    expect(await first).toEqual(LIST);
    await flush();
    expect(writes).toHaveLength(1);
    gate.resolve();
    await flush();
    expect(writes.map((bytes) => decode(bytes).method)).toEqual(["terminal.list", "hello"]);
  });

  test("calls made while hello drains or awaits its reply reject and write nothing", async () => {
    const { client, writes, requests } = capture();
    void client.call("terminal.list", {});
    const hello = track(client.hello());
    const draining = track(client.call("terminal.get", { terminal: "t1" }));
    await flush();
    expect((draining.error as Error).message).toBe(IN_PROGRESS);
    expect(writes).toHaveLength(1);

    client.feed(line({ jsonrpc: "2.0", id: 1, result: LIST }));
    await flush();
    expect(writes).toHaveLength(2);
    const helloId = requests()[1]?.id;
    const waiting = track(client.call("doc.get", { name: "herdr-app" }));
    await flush();
    expect((waiting.error as Error).message).toBe(IN_PROGRESS);
    expect(writes).toHaveLength(2);

    client.feed(line({ jsonrpc: "2.0", id: helloId, result: HC_0_1_16 }));
    await flush();
    expect(hello.value).toEqual(HC_0_1_16);
    void client.call("terminal.list", {});
    expect(framesOf(writes.slice(2))).toHaveLength(1);
  });

  test("a second hello is refused while the first runs, and after it", async () => {
    const { client, writes } = capture();
    const first = client.hello();
    const second = track(client.hello());
    await flush();
    expect((second.error as Error).message).toBe(IN_PROGRESS);
    expect(writes).toHaveLength(1);
    client.feed(line({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 }));
    await first;
    const third = track(client.hello());
    await flush();
    expect((third.error as Error).message).toBe("hello already completed");
    expect(writes).toHaveLength(1);
  });

  test("call('hello') is refused without writing", async () => {
    const { client, writes } = capture();
    const call = track(client.call("hello", { framed: true }));
    await flush();
    expect((call.error as Error).message).toBe("negotiate with hello(), not call()");
    expect(writes).toHaveLength(0);
  });

  test("reads the reply split at any byte, LF or CRLF, and frames from the next byte", async () => {
    for (const ending of ["\n", "\r\n"]) {
      const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 });
      const input = concat(utf8Encode(`${reply}${ending}`), frame(event(1)), dataFrame(5, RAW));
      for (let cut = 1; cut < input.length; cut++) {
        const { client } = capture();
        const seen: JsonRpcNotification[] = [];
        const stream: Uint8Array[] = [];
        client.onNotification((n) => seen.push(n));
        client.routeChannel(5, (f) => stream.push(f.payload));
        const hello = client.hello();
        await flush();
        client.feed(input.subarray(0, cut));
        client.feed(input.subarray(cut));
        expect(await hello).toEqual(HC_0_1_16);
        expect(seen).toEqual([event(1)]);
        expect(stream).toEqual([RAW]);
      }
    }
  });

  test("reads frames that came in the same read as the reply", async () => {
    const { client } = capture();
    const seen: JsonRpcNotification[] = [];
    client.onNotification((n) => seen.push(n));
    const hello = client.hello();
    await flush();
    client.feed(concat(line({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 }), frame(event(1))));
    await hello;
    expect(seen).toEqual([event(1)]);
  });

  test("a generation-2 reply fails with 'Unsupported protocol generation: 2' and ends the connection", async () => {
    const { client, writes } = capture();
    const hello = track(client.hello());
    await flush();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: { ...HC_0_1_16, generation: 2 } }));
    await flush();
    expect((hello.error as Error).message).toBe("Unsupported protocol generation: 2");
    expect(client.isFramed).toBe(false);
    expect(client.isClosed).toBe(true);
    expect(await client.closed).toBe(hello.error);
    const late = track(client.call("terminal.list", {}));
    await flush();
    expect(late.error).toBeInstanceOf(TransportClosedError);
    expect(writes).toHaveLength(1);
  });

  test("an error reply leaves the connection plain", async () => {
    const { client, writes } = capture();
    const hello = track(client.hello());
    await flush();
    const error = {
      code: -32000,
      message: "unsupported_generation",
      data: { kind: "unsupported_generation" },
    };
    client.feed(line({ jsonrpc: "2.0", id: 1, error }));
    await flush();
    expect(hello.error).toBeInstanceOf(HcRpcError);
    expect((hello.error as HcRpcError).kind).toBe("unsupported_generation");
    expect([client.isFramed, client.isClosed]).toEqual([false, false]);
    const call = client.call("terminal.list", {});
    expect(decode(writes[1] as Uint8Array).method).toBe("terminal.list");
    client.feed(line({ jsonrpc: "2.0", id: 2, result: LIST }));
    expect(await call).toEqual(LIST);
  });

  test("a reply that didn't switch to framing leaves the connection plain", async () => {
    const { client, writes } = capture();
    const hello = track(client.hello());
    await flush();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: { ...HC_0_1_16, framed: false } }));
    await flush();
    expect((hello.error as Error).message).toBe("the core did not switch to framed mode");
    expect([client.isFramed, client.isClosed]).toEqual([false, false]);
    void client.call("terminal.list", {});
    expect(writes[1]?.at(-1)).toBe(10);
  });

  test("a call that fails to encode doesn't hold hello back", async () => {
    const { client, requests } = capture();
    const bad = track(client.call("terminal.get", { terminal: 1n } as never));
    void client.hello();
    await flush();
    expect(bad.error).toBeInstanceOf(TypeError);
    expect(requests().map((request) => request.method)).toEqual(["hello"]);
  });

  test("end while hello drains rejects it", async () => {
    const { client, writes } = capture();
    const first = track(client.call("terminal.list", {}));
    const hello = track(client.hello());
    client.end();
    await flush();
    expect(first.error).toBeInstanceOf(TransportClosedError);
    expect(hello.error).toBeInstanceOf(TransportClosedError);
    expect(writes).toHaveLength(1);
  });
});

describe("framed mode", () => {
  test("channel 0 carries one JSON-RPC message per DATA frame; stream channels keep raw bytes", async () => {
    const { client } = await framed();
    const seen: JsonRpcNotification[] = [];
    const stream: Frame[] = [];
    client.onNotification((n) => seen.push(n));
    client.routeChannel(5, (f) => stream.push(f));
    const close = utf8Encode('{"reason":"exited","exit_code":0,"signal":null}');
    client.feed(
      concat(
        dataFrame(5, RAW),
        frame(event(1)),
        encodeFrame({ channel: 5, kind: FrameKind.Close, payload: close }),
      ),
    );
    expect(stream).toEqual([
      { channel: 5, kind: FrameKind.Data, payload: RAW },
      { channel: 5, kind: FrameKind.Close, payload: close },
    ]);
    expect(seen).toEqual([event(1)]);
    expect(client.isClosed).toBe(false);
  });

  test("keeps frames that arrive before their channel is routed, and replays them in order", async () => {
    const { client } = await framed();
    const paint = utf8Encode("\u001b[2Jfirst paint");
    client.feed(concat(dataFrame(7, paint), dataFrame(7, RAW)));
    const stream: Uint8Array[] = [];
    client.routeChannel(7, (f) => stream.push(f.payload));
    expect(stream).toEqual([paint, RAW]);
    client.feed(dataFrame(7, utf8Encode("live")));
    expect(stream).toEqual([paint, RAW, utf8Encode("live")]);
  });

  test("a channel that sends past its opening credit before anyone reads it ends the connection", async () => {
    const { client } = await framed();
    const chunk = new Uint8Array(16 * 1024);
    for (let sent = 0; sent < INITIAL_STREAM_CREDIT; sent += chunk.length) {
      client.feed(dataFrame(9, chunk));
    }
    client.feed(encodeFrame({ channel: 9, kind: FrameKind.Close, payload: utf8Encode("{}") }));
    expect(client.isClosed).toBe(false);
    client.feed(dataFrame(9, new Uint8Array(1)));
    expect(client.isClosed).toBe(true);
    const cause = (await client.closed) as Error;
    expect(cause).toBeInstanceOf(ProtocolError);
    expect(cause.message).toBe(
      `channel 9 sent ${INITIAL_STREAM_CREDIT + 1} bytes before anyone read it`,
    );
  });

  test("the function routeChannel returns stops delivery to that handler", async () => {
    const { client } = await framed();
    const stream: Uint8Array[] = [];
    const unroute = client.routeChannel(3, (f) => stream.push(f.payload));
    client.feed(dataFrame(3, utf8Encode("a")));
    unroute();
    client.feed(dataFrame(3, utf8Encode("b")));
    expect(stream).toEqual([utf8Encode("a")]);
  });

  test("a frame header over 16 MiB ends the connection with a ProtocolError", async () => {
    const { client } = await framed();
    const pending = track(client.call("terminal.list", {}));
    const header = new Uint8Array(9);
    new DataView(header.buffer).setUint32(5, 16 * 1024 * 1024 + 1, true);
    client.feed(header);
    await flush();
    expect(pending.error).toBeInstanceOf(TransportClosedError);
    const cause = (await client.closed) as Error;
    expect(cause).toBeInstanceOf(ProtocolError);
    expect(cause.message).toBe("frame of 16777217 bytes exceeds 16777216");
  });

  test("dispatches frames fed from inside a listener after the frames already in hand", async () => {
    const { client } = await framed();
    const order: number[] = [];
    client.onNotification((n) => {
      const seq = (n.params as { seq: number }).seq;
      order.push(seq);
      if (seq === 1) client.feed(frame(event(3)));
    });
    client.feed(concat(frame(event(1)), frame(event(2))));
    expect(order).toEqual([1, 2, 3]);
  });

  test("a listener or handler error is rethrown after every frame in hand is dispatched", async () => {
    const { client } = await framed();
    const order: string[] = [];
    client.routeChannel(4, () => {
      order.push("stream");
      throw new Error("handler broke");
    });
    client.onNotification((n) => {
      order.push(`event ${(n.params as { seq: number }).seq}`);
      throw new Error("listener broke");
    });
    expect(() => client.feed(concat(dataFrame(4, RAW), frame(event(1)), frame(event(2))))).toThrow(
      "handler broke",
    );
    expect(order).toEqual(["stream", "event 1", "event 2"]);
    expect(client.isClosed).toBe(false);
  });

  test("a loopback transport can answer hello and stream frames from inside the write", async () => {
    let client: HcClient | undefined;
    client = createClient({
      write: (bytes) => {
        if (client?.isFramed) return;
        const request = decode(bytes);
        client?.feed(
          concat(line({ jsonrpc: "2.0", id: request.id, result: HC_0_1_16 }), frame(event(1))),
        );
      },
    });
    const seen: JsonRpcNotification[] = [];
    client.onNotification((n) => seen.push(n));
    expect(await client.hello()).toEqual(HC_0_1_16);
    expect(seen).toEqual([event(1)]);
  });
});
