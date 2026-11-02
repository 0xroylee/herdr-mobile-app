import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  LineDecoder,
  utf8Decode,
  utf8Encode,
} from "@herdr-mobile/hc-client";
import { concat, dataFrame, FakeCore, frame, line } from "@herdr-mobile/hc-client/testing";
import { FrameKind } from "@herdr-mobile/protocol";
import { createGate } from "./gate.ts";

const hello = line({ jsonrpc: "2.0", id: "hello-1", method: "hello", params: { framed: true } });

function errorFromPlain(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(utf8Decode(bytes)) as Record<string, unknown>;
}

function errorFromFrame(bytes: Uint8Array): Record<string, unknown> {
  const frames = new FrameDecoder().push(bytes);
  expect(frames).toHaveLength(1);
  expect(frames[0]?.channel).toBe(0);
  expect(frames[0]?.kind).toBe(FrameKind.Data);
  return JSON.parse(utf8Decode(frames[0]?.payload ?? new Uint8Array())) as Record<string, unknown>;
}

function plainMessages(bytes: Uint8Array): Record<string, unknown>[] {
  const decoder = new LineDecoder();
  decoder.push(bytes);
  const messages: Record<string, unknown>[] = [];
  for (let line = decoder.takeLine(); line; line = decoder.takeLine()) {
    messages.push(JSON.parse(utf8Decode(line.line)) as Record<string, unknown>);
  }
  expect(decoder.buffered).toBe(0);
  return messages;
}

function framedGate(role: "watch" | "control" = "control") {
  const gate = createGate(role);
  gate.fromPhone(hello);
  gate.fromCore(line({ jsonrpc: "2.0", id: "hello-1", result: { framed: true } }));
  return gate;
}

describe("createGate", () => {
  test("denies a forbidden plain request with its id and never forwards it", async () => {
    const gate = createGate("control");
    const core = new FakeCore();
    const result = gate.fromPhone(
      line({ jsonrpc: "2.0", id: 42, method: "server.stop", params: {} }),
    );

    expect(result.toCore).toHaveLength(0);
    expect(errorFromPlain(result.toPhone)).toMatchObject({
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32001, data: { kind: "forbidden", hint: expect.any(String) } },
    });
    await core.write(result.toCore);
    expect(core.calls).toEqual([]);
  });

  test("drops malformed lines, batches, and denied notifications without ids", () => {
    const gate = createGate("watch");
    const result = gate.fromPhone(
      concat(
        utf8Encode("[]\nnot json\n"),
        line({ jsonrpc: "2.0", method: "server.stop", params: {} }),
      ),
    );

    expect(result).toEqual({ toCore: new Uint8Array(0), toPhone: new Uint8Array(0) });
  });

  test("answers every refused id-bearing object in plain and framed mode", async () => {
    const messages = [
      { id: 0 },
      { id: "non-string-method", method: 7 },
      { id: null, method: false },
    ];

    for (const framed of [false, true]) {
      const gate = framed ? framedGate("watch") : createGate("watch");
      const core = new FakeCore();
      for (const message of messages) {
        const result = gate.fromPhone((framed ? frame : line)(message));
        expect(result.toCore).toHaveLength(0);
        const reply = framed ? errorFromFrame(result.toPhone) : errorFromPlain(result.toPhone);
        expect(reply).toMatchObject({
          id: message.id,
          error: { code: -32001, data: { kind: "forbidden", hint: expect.any(String) } },
        });
        await core.write(result.toCore);
      }
      expect(core.calls).toEqual([]);
    }
  });

  test("watch attachments require observe true", async () => {
    const gate = createGate("watch");
    const core = new FakeCore();
    const denied = gate.fromPhone(
      line({ jsonrpc: "2.0", id: 1, method: "terminal.attach", params: { terminal: "t1" } }),
    );
    expect(denied.toCore).toHaveLength(0);
    expect(errorFromPlain(denied.toPhone)).toMatchObject({
      id: 1,
      error: { data: { kind: "forbidden" } },
    });

    const allowedBytes = line({
      jsonrpc: "2.0",
      id: 2,
      method: "terminal.attach",
      params: { terminal: "t1", cols: 80, rows: 24, observe: true },
    });
    const allowed = gate.fromPhone(allowedBytes);
    expect(allowed.toCore).toEqual(allowedBytes);
    await core.write(allowed.toCore);
    expect(core.calls).toEqual(["terminal.attach"]);
  });

  test("switches after the framed hello reply and reads later bytes in the same chunk as frames", async () => {
    const coreBytes: Uint8Array[] = [];
    const core = new FakeCore((bytes) => coreBytes.push(bytes));
    const gate = createGate("control");
    const request = gate.fromPhone(hello);
    await core.write(request.toCore);
    const helloReply = coreBytes.shift();
    expect(helloReply).toBeDefined();

    const streamData = dataFrame(7, utf8Encode("attach data"));
    const streamCredit = encodeFrame({
      channel: 7,
      kind: FrameKind.Credit,
      payload: Uint8Array.of(4, 0, 0, 0),
    });
    core.send({ channel: 7, kind: FrameKind.Data, payload: utf8Encode("attach data") });
    core.send({ channel: 7, kind: FrameKind.Credit, payload: Uint8Array.of(4, 0, 0, 0) });
    const afterHello = concat(helloReply as Uint8Array, ...coreBytes);
    coreBytes.length = 0;

    expect(gate.fromCore(afterHello).toPhone).toEqual(afterHello);

    const phoneBytes = concat(streamData, streamCredit);
    const phone = gate.fromPhone(phoneBytes);
    expect(phone.toCore).toEqual(phoneBytes);
    expect(phone.toPhone).toHaveLength(0);
    await core.write(phone.toCore);
    expect(core.received.map(({ channel, kind }) => [channel, kind])).toEqual([
      [7, FrameKind.Data],
      [7, FrameKind.Credit],
    ]);
  });

  test("a denied framed method returns a channel-zero error and does not reach the core", async () => {
    const coreBytes: Uint8Array[] = [];
    const core = new FakeCore((bytes) => coreBytes.push(bytes));
    const gate = createGate("control");
    const request = gate.fromPhone(hello);
    await core.write(request.toCore);
    const helloReply = coreBytes.shift() as Uint8Array;
    gate.fromCore(helloReply);

    const denied = gate.fromPhone(frame({ jsonrpc: "2.0", id: "stop", method: "server.stop" }));
    expect(denied.toCore).toHaveLength(0);
    expect(errorFromFrame(denied.toPhone)).toMatchObject({
      id: "stop",
      error: { code: -32001, data: { kind: "forbidden", hint: expect.any(String) } },
    });
    expect(core.calls).toEqual(["hello"]);
  });

  test("keeps plain mode after an error reply to hello", async () => {
    const coreBytes: Uint8Array[] = [];
    const core = new FakeCore((bytes) => coreBytes.push(bytes));
    core.helloError = { code: -32000, message: "unavailable" };
    const gate = createGate("control");
    await core.write(gate.fromPhone(hello).toCore);
    const errorReply = concat(...coreBytes.splice(0));
    expect(gate.fromCore(errorReply).toPhone).toEqual(errorReply);

    const next = line({ jsonrpc: "2.0", id: 2, method: "server.status" });
    expect(gate.fromPhone(next).toCore).toEqual(next);
  });

  test("buffers split phone lines at every byte boundary", () => {
    const request = line({ jsonrpc: "2.0", id: "split-line", method: "server.status" });
    for (let cut = 0; cut <= request.length; cut++) {
      const gate = createGate("control");
      const first = gate.fromPhone(request.subarray(0, cut));
      const second = gate.fromPhone(request.subarray(cut));
      expect(concat(first.toCore, second.toCore)).toEqual(request);
      expect(concat(first.toPhone, second.toPhone)).toHaveLength(0);
    }
  });

  test("buffers phone frames split throughout their header and payload", () => {
    const request = frame({ jsonrpc: "2.0", id: "split-frame", method: "server.status" });
    for (let cut = 1; cut < request.length; cut++) {
      const gate = framedGate();
      const first = gate.fromPhone(request.subarray(0, cut));
      const second = gate.fromPhone(request.subarray(cut));
      expect(concat(first.toCore, second.toCore)).toEqual(request);
      expect(concat(first.toPhone, second.toPhone)).toHaveLength(0);
    }
  });

  test("holds incomplete plain core replies while local denials are sent", () => {
    const response = line({ jsonrpc: "2.0", id: "status", result: { healthy: true } });
    const denied = line({ jsonrpc: "2.0", id: "stop", method: "server.stop" });

    for (const cut of [1, 5, 10, response.length - 1]) {
      const gate = createGate("control");
      const first = gate.fromCore(response.subarray(0, cut)).toPhone;
      expect(first).toHaveLength(0);
      const local = gate.fromPhone(denied);
      expect(local.toCore).toHaveLength(0);
      const last = gate.fromCore(response.subarray(cut)).toPhone;
      const messages = plainMessages(concat(first, local.toPhone, last));
      expect(messages).toHaveLength(2);
      expect(messages).toContainEqual({ jsonrpc: "2.0", id: "status", result: { healthy: true } });
      expect(messages.find(({ id }) => id === "stop")).toMatchObject({
        error: { code: -32001, data: { kind: "forbidden" } },
      });
    }
  });

  test("holds incomplete framed core output while local denials are sent", () => {
    const response = dataFrame(7, utf8Encode("terminal output stays intact"));
    const denied = frame({ jsonrpc: "2.0", id: "stop", method: "server.stop" });
    const cuts = [1, 4, 8, 10, 12, 18, response.length - 1];

    for (const cut of cuts) {
      const gate = framedGate();
      const first = gate.fromCore(response.subarray(0, cut)).toPhone;
      expect(first).toHaveLength(0);
      const local = gate.fromPhone(denied);
      expect(local.toCore).toHaveLength(0);
      const last = gate.fromCore(response.subarray(cut)).toPhone;
      const decoder = new FrameDecoder();
      const frames = decoder.push(concat(first, local.toPhone, last));
      decoder.finish();
      expect(frames).toHaveLength(2);
      expect(frames.find(({ channel }) => channel === 7)?.payload).toEqual(
        utf8Encode("terminal output stays intact"),
      );
      expect(
        JSON.parse(
          utf8Decode(frames.find(({ channel }) => channel === 0)?.payload ?? new Uint8Array()),
        ),
      ).toMatchObject({
        id: "stop",
        error: { code: -32001, data: { kind: "forbidden" } },
      });
    }
  });

  test("splits successful and error hello replies at every byte and preserves the switch", () => {
    const success = line({ jsonrpc: "2.0", id: "hello-1", result: { framed: true } });
    const failure = line({
      jsonrpc: "2.0",
      id: "hello-1",
      error: { code: -32000, message: "unavailable" },
    });

    for (let cut = 1; cut < success.length; cut++) {
      const gate = createGate("control");
      gate.fromPhone(hello);
      expect(gate.fromCore(success.subarray(0, cut)).toPhone).toHaveLength(0);
      expect(gate.fromCore(success.subarray(cut)).toPhone).toEqual(success);
      const request = frame({ jsonrpc: "2.0", id: "status", method: "server.status" });
      expect(gate.fromPhone(request).toCore).toEqual(request);
    }

    for (let cut = 1; cut < failure.length; cut++) {
      const gate = createGate("control");
      gate.fromPhone(hello);
      expect(gate.fromCore(failure.subarray(0, cut)).toPhone).toHaveLength(0);
      expect(gate.fromCore(failure.subarray(cut)).toPhone).toEqual(failure);
      const request = line({ jsonrpc: "2.0", id: "status", method: "server.status" });
      expect(gate.fromPhone(request).toCore).toEqual(request);
    }
  });

  test("does not switch when hello omits framed, then retries after an error", () => {
    const gate = createGate("control");
    const plainHello = line({
      jsonrpc: "2.0",
      id: "hello-plain",
      method: "hello",
      params: { generation: 1 },
    });
    gate.fromPhone(plainHello);
    const plainReply = line({ jsonrpc: "2.0", id: "hello-plain", result: { generation: 1 } });
    expect(gate.fromCore(plainReply).toPhone).toEqual(plainReply);
    const plainStatus = line({ jsonrpc: "2.0", id: "plain-status", method: "server.status" });
    expect(gate.fromPhone(plainStatus).toCore).toEqual(plainStatus);

    gate.fromPhone(hello);
    const error = line({
      jsonrpc: "2.0",
      id: "hello-1",
      error: { code: -32000, message: "unavailable" },
    });
    expect(gate.fromCore(error).toPhone).toEqual(error);
    const retry = line({
      jsonrpc: "2.0",
      id: "hello-2",
      method: "hello",
      params: { framed: true },
    });
    expect(gate.fromPhone(retry).toCore).toEqual(retry);
    const retryReply = line({ jsonrpc: "2.0", id: "hello-2", result: { framed: true } });
    expect(gate.fromCore(retryReply).toPhone).toEqual(retryReply);
    const framedStatus = frame({ jsonrpc: "2.0", id: "framed-status", method: "server.status" });
    expect(gate.fromPhone(framedStatus).toCore).toEqual(framedStatus);
  });

  test("forwards a second hello after the connection is framed", () => {
    const gate = framedGate();
    const secondHello = frame({
      jsonrpc: "2.0",
      id: "hello-2",
      method: "hello",
      params: { framed: true },
    });
    expect(gate.fromPhone(secondHello).toCore).toEqual(secondHello);
    const reply = frame({ jsonrpc: "2.0", id: "hello-2", result: { framed: true } });
    expect(gate.fromCore(reply).toPhone).toEqual(reply);
    const status = frame({ jsonrpc: "2.0", id: "status", method: "server.status" });
    expect(gate.fromPhone(status).toCore).toEqual(status);
  });
});
