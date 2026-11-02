import { describe, expect, test } from "bun:test";
import type { JsonRpcNotification } from "@herdr-mobile/protocol";
import { createClient, type HcClient } from "./client.ts";
import { HcRpcError, ProtocolError, TransportClosedError } from "./errors.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

type Message = Record<string, unknown>;

const line = (message: unknown) => utf8Encode(`${JSON.stringify(message)}\n`);
const lines = (...messages: unknown[]) =>
  utf8Encode(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
const decode = (bytes: Uint8Array) => JSON.parse(utf8Decode(bytes)) as Message;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records how a promise settles without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

/** A client whose writes are captured. */
function capture() {
  const writes: Uint8Array[] = [];
  const client = createClient({
    write: (bytes) => {
      writes.push(bytes);
    },
  });
  return { client, writes, requests: () => writes.map(decode) };
}

describe("plain requests", () => {
  test("writes one LF-terminated JSON-RPC line through the injected writer", () => {
    const { client, writes, requests } = capture();
    void client.call("terminal.get", { terminal: "t1" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.at(-1)).toBe(10);
    expect(writes[0]?.filter((byte) => byte === 10)).toHaveLength(1);
    expect(requests()).toEqual([
      { jsonrpc: "2.0", id: 1, method: "terminal.get", params: { terminal: "t1" } },
    ]);
  });

  test("resolves replies by id, even in reverse order", async () => {
    const { client } = capture();
    const first = client.call("terminal.get", { terminal: "t1" });
    const second = client.call("terminal.get", { terminal: "t2" });
    client.feed(
      lines(
        { jsonrpc: "2.0", id: 2, result: "second" },
        { jsonrpc: "2.0", id: 1, result: "first" },
      ),
    );
    expect(await first).toBe("first" as never);
    expect(await second).toBe("second" as never);
  });

  test("keeps null, false, zero and empty-string results", async () => {
    const { client } = capture();
    const calls = [1, 2, 3, 4].map(() => client.call("doc.get", { name: "d" }) as Promise<unknown>);
    client.feed(
      lines(
        { jsonrpc: "2.0", id: 1, result: null },
        { jsonrpc: "2.0", id: 2, result: false },
        { jsonrpc: "2.0", id: 3, result: 0 },
        { jsonrpc: "2.0", id: 4, result: "" },
      ),
    );
    expect(await Promise.all(calls)).toEqual([null, false, 0, ""]);
  });

  test("rejects with the whole error object, data.kind and hint included", async () => {
    const { client } = capture();
    const call = track(client.call("terminal.get", { terminal: "t9" }));
    const error = {
      code: -32000,
      message: "no terminal t9",
      data: { kind: "not_found", hint: "run hc ls", detail: { terminal: "t9" } },
      retryable: false,
    };
    client.feed(line({ jsonrpc: "2.0", id: 1, error }));
    await flush();
    expect(call.error).toBeInstanceOf(HcRpcError);
    const rpc = call.error as HcRpcError;
    expect([rpc.message, rpc.code, rpc.kind, rpc.hint]).toEqual([
      "no terminal t9",
      -32000,
      "not_found",
      "run hc ls",
    ]);
    expect(rpc.data).toEqual(error.data);
    expect(rpc.toObject()).toEqual(error);
  });

  test("rejects a reply carrying both result and error, or neither", async () => {
    const { client } = capture();
    const both = track(client.call("terminal.list", {}));
    const neither = track(client.call("terminal.list", {}));
    client.feed(
      lines(
        { jsonrpc: "2.0", id: 1, result: "foo", error: { code: 0, message: "bar" } },
        { jsonrpc: "2.0", id: 2 },
      ),
    );
    await flush();
    expect(both.error).toBeInstanceOf(ProtocolError);
    expect(neither.error).toBeInstanceOf(ProtocolError);
  });

  test("delivers notifications to listeners without touching pending calls", async () => {
    const { client } = capture();
    const call = track(client.call("terminal.list", {}));
    const seen: JsonRpcNotification[] = [];
    const stop = client.onNotification((n) => seen.push(n));
    const event = {
      jsonrpc: "2.0",
      method: "event",
      params: { seq: 42, type: "status", terminal: "t7", data: {} },
    };
    client.feed(line(event));
    await flush();
    expect(seen).toEqual([event as JsonRpcNotification]);
    expect(call.settled).toBe(false);
    stop();
    client.feed(line(event));
    expect(seen).toHaveLength(1);
  });

  test("waits for a line's newline before acting on it", async () => {
    const { client } = capture();
    const call = track(client.call("terminal.list", {}));
    client.feed(utf8Encode('{"jsonrpc":"2.0","id":1,"result":"done"}'));
    await flush();
    expect(call.settled).toBe(false);
    client.feed(utf8Encode("\r\n"));
    await flush();
    expect(call.value).toBe("done" as never);
  });

  test("reads LF and CRLF endings mixed in one chunk", async () => {
    const { client } = capture();
    const calls = [1, 2, 3].map(() => client.call("terminal.list", {}) as Promise<unknown>);
    client.feed(
      utf8Encode(
        [1, 2, 3]
          .map(
            (id, i) =>
              `${JSON.stringify({ jsonrpc: "2.0", id, result: id })}${i === 0 ? "\n" : "\r\n"}`,
          )
          .join(""),
      ),
    );
    expect(await Promise.all(calls)).toEqual([1, 2, 3]);
  });

  test("joins a UTF-8 character split across reads", async () => {
    const { client } = capture();
    const call = client.call("terminal.read", { terminal: "t1" }) as Promise<unknown>;
    const bytes = line({ jsonrpc: "2.0", id: 1, result: "漢🙂" });
    const cut = bytes.indexOf(0xf0) + 2;
    client.feed(bytes.subarray(0, cut));
    client.feed(bytes.subarray(cut));
    expect(await call).toBe("漢🙂");
  });

  test("handles a reply fed back while the write is still running", async () => {
    let client: HcClient | undefined;
    client = createClient({
      write: (bytes) => {
        const request = decode(bytes);
        client?.feed(line({ jsonrpc: "2.0", id: request.id, result: "looped" }));
      },
    });
    expect(await client.call("terminal.list", {})).toBe("looped" as never);
  });

  test("dispatches input fed from inside a listener after the input already in hand", () => {
    const order: number[] = [];
    let client: HcClient | undefined;
    client = createClient({
      write: (bytes) => {
        const request = decode(bytes);
        client?.feed(
          lines(
            { jsonrpc: "2.0", id: request.id, result: true },
            { jsonrpc: "2.0", method: "event", params: { seq: 3 } },
          ),
        );
      },
    });
    client.onNotification((n) => {
      const seq = (n.params as { seq: number }).seq;
      order.push(seq);
      if (seq === 1) void client?.call("terminal.list", {});
    });
    client.feed(
      lines(
        { jsonrpc: "2.0", method: "event", params: { seq: 1 } },
        { jsonrpc: "2.0", method: "event", params: { seq: 2 } },
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  test("ends the connection on input that isn't JSON-RPC", async () => {
    const { client } = capture();
    const call = track(client.call("terminal.list", {}));
    client.feed(utf8Encode("not json\n"));
    await flush();
    expect(client.isClosed).toBe(true);
    expect(call.error).toBeInstanceOf(TransportClosedError);
    expect((call.error as Error).cause).toBeInstanceOf(ProtocolError);
    expect(await client.closed).toBeInstanceOf(ProtocolError);
  });
});

describe("the write queue", () => {
  test("runs writes one at a time, in order", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const client = createClient({
      write: (bytes) => {
        const id = decode(bytes).id as number;
        started.push(id);
        return gates[id - 1]?.promise;
      },
    });
    for (let i = 0; i < 3; i++) void client.call("terminal.list", {});
    expect(started).toEqual([1]);
    gates[0]?.resolve();
    await flush();
    expect(started).toEqual([1, 2]);
    gates[1]?.resolve();
    await flush();
    expect(started).toEqual([1, 2, 3]);
  });

  test("end rejects the running write's call and every queued one, and late completion starts nothing", async () => {
    const first = deferred();
    let invocations = 0;
    const client = createClient({
      write: () => {
        invocations++;
        return invocations === 1 ? first.promise : undefined;
      },
    });
    const calls = [
      client.call("terminal.list", {}),
      client.call("terminal.get", { terminal: "t1" }),
      client.call("doc.get", { name: "d" }),
    ].map((call) => track(call as Promise<unknown>));
    expect(invocations).toBe(1);
    client.end();
    await flush();
    for (const call of calls) {
      expect(call.error).toBeInstanceOf(TransportClosedError);
      expect((call.error as Error).message).toBe("hc connection closed");
    }
    first.resolve();
    await flush();
    expect(invocations).toBe(1);
  });

  test("a writer that rejects fails its call with the writer's error and ends the rest", async () => {
    const gate = deferred();
    const client = createClient({ write: () => gate.promise });
    const failing = track(client.call("terminal.list", {}));
    const queued = track(client.call("terminal.list", {}));
    gate.reject(new Error("This is a test. Do not panic."));
    await flush();
    expect((failing.error as Error).message).toBe("This is a test. Do not panic.");
    expect(queued.error).toBeInstanceOf(TransportClosedError);
    expect(client.isClosed).toBe(true);
  });

  test("a writer that rejects without a message fails with 'Failed to send a request'", async () => {
    for (const reason of [undefined, {}]) {
      const client = createClient({ write: () => Promise.reject(reason) });
      const call = track(client.call("terminal.list", {}));
      await flush();
      expect((call.error as Error).message).toBe("Failed to send a request");
    }
  });

  test("a writer that throws synchronously settles the request, the queue and pending replies", async () => {
    const gate = deferred();
    let invocations = 0;
    const client = createClient({
      write: () => {
        invocations++;
        if (invocations === 1) return gate.promise;
        throw new Error("pipe broke");
      },
    });
    const sent = track(client.call("terminal.list", {}));
    const throwing = track(client.call("terminal.list", {}));
    const queued = track(client.call("terminal.list", {}));
    gate.resolve();
    await flush();
    expect(sent.error).toBeInstanceOf(TransportClosedError);
    expect((throwing.error as Error).message).toBe("pipe broke");
    expect(queued.error).toBeInstanceOf(TransportClosedError);
    expect(invocations).toBe(2);
  });

  test("after end, calls reject and input is ignored", async () => {
    const { client, writes } = capture();
    const pending = track(client.call("terminal.list", {}));
    client.end();
    const late = track(client.call("terminal.list", {}));
    client.feed(line({ jsonrpc: "2.0", id: 1, result: "late" }));
    await flush();
    expect(pending.error).toBeInstanceOf(TransportClosedError);
    expect(late.error).toBeInstanceOf(TransportClosedError);
    expect(writes).toHaveLength(1);
    expect(await client.closed).toBeUndefined();
  });
});

/** A tiny fake core: answers echo calls, fails one terminal, and sends an event first. */
function fakeCore(request: Message): Uint8Array {
  const id = request.id;
  const event = { jsonrpc: "2.0", method: "event", params: { seq: id, type: "title" } };
  const params = request.params as { terminal?: string };
  const reply =
    params.terminal === "t9"
      ? {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "no terminal t9", data: { kind: "not_found" } },
        }
      : { jsonrpc: "2.0", id, result: { method: request.method, params, text: "é 漢 🙂" } };
  return lines(event, reply);
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** Runs the same calls over a transport that delivers bytes with `deliver`. */
async function transcript(
  deliver: (client: HcClient, bytes: Uint8Array) => void,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let client: HcClient | undefined;
  client = createClient({
    write: (bytes) => {
      const reply = fakeCore(decode(bytes));
      setTimeout(() => client && deliver(client, reply), 0);
    },
  });
  client.onNotification((n) => out.push(n));
  const calls = [
    client.call("terminal.get", { terminal: "t1" }),
    client.call("terminal.get", { terminal: "t9" }),
    client.call("terminal.read", { terminal: "t2", lines: 5 }),
  ];
  for (const settled of await Promise.allSettled(calls)) {
    out.push(
      settled.status === "fulfilled" ? settled.value : (settled.reason as HcRpcError).toObject(),
    );
  }
  return out;
}

describe("transports", () => {
  test("a chunked byte stream and a message-per-line transport give the same results", async () => {
    const messages = await transcript((client, bytes) => {
      for (let at = 0; at < bytes.length; ) {
        const end = bytes.indexOf(10, at) + 1;
        client.feed(bytes.subarray(at, end));
        at = end;
      }
    });
    for (const seed of [1, 7, 42, 99]) {
      const random = seeded(seed);
      const chunked = await transcript((client, bytes) => {
        for (let at = 0; at < bytes.length; ) {
          const size = 1 + Math.floor(random() * 7);
          client.feed(bytes.subarray(at, at + size));
          at += size;
        }
      });
      expect(chunked).toEqual(messages);
    }
    expect(messages).toHaveLength(6);
  });
});
