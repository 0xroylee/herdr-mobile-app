import { describe, expect, test } from "bun:test";
import { FrameKind, INITIAL_STREAM_CREDIT } from "@herdr-mobile/protocol";
import type { AttachHandle, StreamEnd } from "./attach.ts";
import { HcRpcError, StreamClosedError, TransportClosedError } from "./errors.ts";
import { decodeFacts, decodeFocus, decodeResize } from "./frame.ts";
import { capture, concat, decode, FakeCore, flush, terminalRecord, track } from "./testing.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

const OBSERVE_ONLY = "observe attachment cannot type or resize";
const EXITED = { reason: "exited", exit_code: 0, signal: null };
const SIGNALED = { reason: "exited", exit_code: null, signal: 15, detail: { fixture: true } };

async function opened() {
  const core = new FakeCore();
  await core.open();
  return core;
}

/** An attachment whose DATA is collected and left unconsumed. */
async function attached(core: FakeCore, terminal: string, extra: { observe?: boolean } = {}) {
  const chunks: Uint8Array[] = [];
  const handle = await core.attach(terminal, (bytes) => chunks.push(bytes), extra);
  const bytes = () => chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return { handle, chunks, bytes, text: () => utf8Decode(concat(...chunks)) };
}

/** Key DATA the client wrote on stream channels, as [channel, text]. */
const keys = (core: FakeCore) =>
  core.received
    .filter((f) => f.kind === FrameKind.Data && f.channel !== 0)
    .map((f) => [f.channel, utf8Decode(f.payload)]);

describe("attachments", () => {
  test("two attachments keep their own channels, output and credit", async () => {
    const core = await opened();
    core.paint = utf8Encode("paint-a|");
    const a = await attached(core, "t1");
    core.paint = utf8Encode("paint-b|");
    const b = await attached(core, "t2");
    expect([a.handle.channel, b.handle.channel]).toEqual([1, 2]);
    expect(a.handle.terminal).toEqual(terminalRecord("t1"));

    core.output(1, utf8Encode("a1|"));
    core.output(2, utf8Encode("b1|"));
    core.output(1, utf8Encode("a2|"));
    expect(a.text()).toBe("paint-a|a1|a2|");
    expect(b.text()).toBe("paint-b|b1|");

    a.handle.consume(5);
    b.handle.consume(8);
    expect([core.credits(1), core.credits(2)]).toEqual([[5], [8]]);

    expect(await a.handle.detach()).toEqual({ kind: "detached" });
    core.output(2, utf8Encode("b2|"));
    expect(b.text()).toBe("paint-b|b1|b2|");
    expect(a.text()).toBe("paint-a|a1|a2|");
  });

  test("the first paint comes first, whether it arrives before or after the reply", async () => {
    for (const paintFirst of [false, true]) {
      const core = await opened();
      core.paintFirst = paintFirst;
      const a = await attached(core, "t1");
      core.output(1, utf8Encode("live"));
      expect(a.text()).toBe(`${utf8Decode(core.paint)}live`);
    }
  });

  test("keys from overlapping writes go out in order, each on its own channel", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    const b = await attached(core, "t2");
    const settled: string[] = [];
    const release = core.holdNextWrite();
    const writes = [
      a.handle.writeInput(utf8Encode("A")).then(() => settled.push("A")),
      b.handle.writeInput(utf8Encode("B")).then(() => settled.push("B")),
      a.handle.writeInput(utf8Encode("C")).then(() => settled.push("C")),
    ];
    expect(keys(core)).toEqual([[1, "A"]]);
    release();
    await Promise.all(writes);
    expect(keys(core)).toEqual([
      [1, "A"],
      [2, "B"],
      [1, "C"],
    ]);
    expect(settled).toEqual(["A", "B", "C"]);
  });

  test("an interactive attachment sends RESIZE, FOCUS and FACTS on its channel", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    await a.handle.writeInput(utf8Encode("ls\r"));
    await a.handle.resize(120, 40);
    await a.handle.focus(false);
    await a.handle.facts({ fg: "#d0d0d0", bg: "#101010", cell: [9, 18] });
    expect(keys(core)).toEqual([[1, "ls\r"]]);
    expect(core.frames(1, FrameKind.Resize).map((f) => decodeResize(f.payload))).toEqual([
      { cols: 120, rows: 40 },
    ]);
    expect(core.frames(1, FrameKind.Focus).map((f) => decodeFocus(f.payload))).toEqual([false]);
    expect(core.frames(1, FrameKind.Facts).map((f) => decodeFacts(f.payload))).toEqual([
      { fg: "#d0d0d0", bg: "#101010", cell: [9, 18] },
    ]);
  });

  test("output stops at the core's opening window until bytes are consumed", async () => {
    const core = await opened();
    core.paint = new Uint8Array(0);
    const a = await attached(core, "t1");
    core.output(1, new Uint8Array(600 * 1024).fill(0x61));
    expect(a.bytes()).toBe(INITIAL_STREAM_CREDIT);
    expect(core.credits(1)).toEqual([]);
    a.handle.consume(INITIAL_STREAM_CREDIT);
    expect(a.bytes()).toBe(2 * INITIAL_STREAM_CREDIT);
    a.handle.consume(INITIAL_STREAM_CREDIT);
    expect(a.bytes()).toBe(600 * 1024);
  });

  test("credit goes back once rendering is done, not when bytes arrive", async () => {
    const core = await opened();
    const renders: (() => void)[] = [];
    let handle: AttachHandle | undefined;
    handle = await core.attach("t1", (bytes) => {
      renders.push(() => handle?.consume(bytes.length));
    });
    core.output(1, utf8Encode("live"));
    expect(renders).toHaveLength(2);
    expect(core.credits(1)).toEqual([]);
    renders[0]?.();
    expect(core.credits(1)).toEqual([core.paint.length]);
    renders[1]?.();
    expect(core.credits(1)).toEqual([core.paint.length, 4]);
  });

  test("credit counts bytes, not characters", async () => {
    const core = await opened();
    core.paint = new Uint8Array(0);
    const a = await attached(core, "t1");
    const glyphs = utf8Encode("漢🙂é");
    expect([glyphs.length, "漢🙂é".length]).toEqual([9, 4]);
    core.output(1, glyphs);
    a.handle.consume(a.bytes());
    expect(core.credits(1)).toEqual([9]);
  });

  test("consume refuses counts it wasn't given, and sends nothing for zero", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    for (const count of [a.bytes() + 1, -1, 1.5]) {
      expect(() => a.handle.consume(count)).toThrow(RangeError);
    }
    a.handle.consume(0);
    expect(core.credits(1)).toEqual([]);
  });

  test("a repaint after the opening window comes through unchanged", async () => {
    const core = await opened();
    core.paint = new Uint8Array(0);
    const a = await attached(core, "t1");
    core.output(1, new Uint8Array(INITIAL_STREAM_CREDIT).fill(0x2e));
    a.handle.consume(INITIAL_STREAM_CREDIT);
    const repaint = utf8Encode("\u001bc\u001b[H\u001b[2Jrepainted screen");
    core.output(1, repaint);
    expect(a.chunks.at(-1)).toEqual(repaint);
    expect(a.bytes()).toBe(INITIAL_STREAM_CREDIT + repaint.length);
  });

  test("detach sends one empty CLOSE and settles on the core's empty CLOSE", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    const closed = track(a.handle.closed);
    expect(await a.handle.detach()).toEqual({ kind: "detached" });
    const closes = core.frames(1, FrameKind.Close);
    expect(closes.map((f) => f.payload.length)).toEqual([0]);
    await flush();
    expect(closed.value).toEqual({ kind: "detached" });
    expect(await a.handle.detach()).toEqual({ kind: "detached" });
    expect(core.frames(1, FrameKind.Close)).toHaveLength(1);
  });

  test("input written before detach goes out ahead of its CLOSE", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    const b = await attached(core, "t2");
    const release = core.holdNextWrite();
    void b.handle.writeInput(utf8Encode("held"));
    const typed = track(a.handle.writeInput(utf8Encode("q")));
    const detached = a.handle.detach();
    release();
    expect(await detached).toEqual({ kind: "detached" });
    expect(typed.error).toBeUndefined();
    const onA = core.received.filter((f) => f.channel === 1).map((f) => f.kind);
    expect(onA).toEqual([FrameKind.Data, FrameKind.Close]);
  });

  test("a program's end keeps the core's whole CLOSE reason, after its last output", async () => {
    for (const reason of [EXITED, SIGNALED]) {
      const core = await opened();
      const events: string[] = [];
      const handle = await core.attach("t1", (bytes) => events.push(utf8Decode(bytes)));
      handle.closed.then((end) => events.push(`closed:${end.kind}`));
      core.output(1, utf8Encode("last words"));
      core.finish(1, reason);
      const end: StreamEnd = await handle.closed;
      expect(end).toEqual({ kind: "program", reason });
      expect(events.slice(-2)).toEqual(["last words", "closed:program"]);
    }
  });

  test("the program's CLOSE waits for output still held back by credit", async () => {
    const core = await opened();
    core.paint = new Uint8Array(0);
    const a = await attached(core, "t1");
    core.output(1, new Uint8Array(300 * 1024).fill(0x7a));
    core.finish(1, EXITED);
    const closed = track(a.handle.closed);
    await flush();
    expect(closed.settled).toBe(false);
    a.handle.consume(a.bytes());
    await flush();
    expect(a.bytes()).toBe(300 * 1024);
    expect(closed.value).toEqual({ kind: "program", reason: EXITED });
  });

  test("an observer gets output but can't type or resize", async () => {
    const core = await opened();
    const o = await attached(core, "t1", { observe: true });
    expect(o.handle.observe).toBe(true);
    expect(decode(core.frames(0, FrameKind.Data)[0]?.payload as Uint8Array).params).toEqual({
      terminal: "t1",
      cols: 80,
      rows: 24,
      observe: true,
    });
    core.output(1, utf8Encode("live"));
    expect(o.text()).toBe(`${utf8Decode(core.paint)}live`);

    const typed = track(o.handle.writeInput(utf8Encode("x")));
    const resized = track(o.handle.resize(100, 30));
    await flush();
    expect((typed.error as Error).message).toBe(OBSERVE_ONLY);
    expect((resized.error as Error).message).toBe(OBSERVE_ONLY);
    expect(core.frames(1, FrameKind.Data)).toEqual([]);
    expect(core.frames(1, FrameKind.Resize)).toEqual([]);

    await o.handle.focus(true);
    await o.handle.facts({ fg: "#ffffff" });
    expect(core.frames(1, FrameKind.Focus)).toHaveLength(1);
    expect(core.frames(1, FrameKind.Facts)).toHaveLength(1);
  });

  test("frames for a channel after its stream ended are dropped", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    await a.handle.detach();
    const before = a.chunks.length;
    for (let i = 0; i < 20; i++) {
      core.send({ channel: 1, kind: FrameKind.Data, payload: new Uint8Array(16 * 1024) });
    }
    expect(a.chunks).toHaveLength(before);
    expect(core.client.isClosed).toBe(false);
  });

  test("attach needs a framed connection, and call('terminal.attach') is refused", async () => {
    const { client, writes } = capture();
    const params = { terminal: "t1", cols: 80, rows: 24 };
    const attach = track(client.attach(params, { onData() {} }));
    const call = track(client.call("terminal.attach", params));
    await flush();
    expect((attach.error as Error).message).toBe(
      "attach needs a framed connection: call hello() first",
    );
    expect((call.error as Error).message).toBe("open attachments with attach(), not call()");
    expect(writes).toHaveLength(0);
  });

  test("a failed attach routes nothing", async () => {
    const core = await opened();
    const failed = track(core.attach("missing", () => {}));
    await flush();
    expect(failed.error).toBeInstanceOf(HcRpcError);
    expect((failed.error as HcRpcError).kind).toBe("not_found");
  });
});

describe("attachment lifetime", () => {
  test("end settles a pending detach, the running write and queued ones, and closed once", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    const release = core.holdNextWrite();
    const running = track(a.handle.writeInput(utf8Encode("x")));
    const queued = track(a.handle.writeInput(utf8Encode("y")));
    const detach = track(a.handle.detach());
    let closings = 0;
    a.handle.closed.then(() => closings++);
    const written = core.received.length;

    core.client.end();
    await flush();
    for (const state of [running, queued, detach]) {
      expect(state.error).toBeInstanceOf(TransportClosedError);
      expect((state.error as Error).message).toBe("hc connection closed");
    }
    expect(closings).toBe(1);
    expect(await a.handle.closed).toEqual({ kind: "transport", cause: undefined });

    release();
    a.handle.consume(a.bytes());
    core.client.end();
    await flush();
    expect(closings).toBe(1);
    expect(core.received).toHaveLength(written);
  });

  test("after the connection ends, input and controls reject with 'hc stream closed'", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    core.client.end();
    const written = core.received.length;
    const calls = [
      a.handle.writeInput(utf8Encode("x")),
      a.handle.resize(90, 30),
      a.handle.focus(true),
      a.handle.facts({}),
    ].map((call) => track(call));
    await flush();
    for (const call of calls) {
      expect(call.error).toBeInstanceOf(StreamClosedError);
      expect((call.error as Error).message).toBe("hc stream closed");
    }
    expect(core.received).toHaveLength(written);
  });

  test("a renderer callback after its stream ended sends no CREDIT", async () => {
    const core = await opened();
    const finished = await attached(core, "t1");
    core.finish(1, EXITED);
    await finished.handle.closed;
    finished.handle.consume(finished.bytes());

    const detached = await attached(core, "t2");
    await detached.handle.detach();
    detached.handle.consume(detached.bytes());

    const ended = await attached(core, "t3");
    core.client.end();
    ended.handle.consume(ended.bytes() + 1);
    await flush();
    expect([core.credits(1), core.credits(2), core.credits(3)]).toEqual([[], [], []]);
  });

  test("a finished program's reason survives a duplicate CLOSE and a later end", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    core.finish(1, SIGNALED);
    expect(await a.handle.closed).toEqual({ kind: "program", reason: SIGNALED });
    core.send({ channel: 1, kind: FrameKind.Close, payload: new Uint8Array(0) });
    core.client.end();
    expect(await a.handle.detach()).toEqual({ kind: "program", reason: SIGNALED });
  });

  test("queued input whose stream ends before its turn is dropped with 'hc stream closed'", async () => {
    const core = await opened();
    const a = await attached(core, "t1");
    const b = await attached(core, "t2");
    const release = core.holdNextWrite();
    const first = track(b.handle.writeInput(utf8Encode("b")));
    const late = track(a.handle.writeInput(utf8Encode("a")));
    core.finish(1, { reason: "killed", exit_code: null, signal: 9 });
    await a.handle.closed;
    release();
    await flush();
    expect([first.settled, first.error]).toEqual([true, undefined]);
    expect(late.error).toBeInstanceOf(StreamClosedError);
    expect(core.frames(1, FrameKind.Data)).toEqual([]);
  });
});
