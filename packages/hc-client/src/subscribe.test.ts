import { describe, expect, test } from "bun:test";
import {
  type EventsSubscribeParams,
  FrameKind,
  type HcEvent,
  type JsonRpcNotification,
  type ListResult,
} from "@herdr-mobile/protocol";
import { createClient } from "./client.ts";
import { HcRpcError, ProtocolError, TransportClosedError } from "./errors.ts";
import type { EventSnapshot } from "./subscribe.ts";
import {
  capture,
  dataFrame,
  FakeCore,
  flush,
  frame,
  HC_0_1_16,
  line,
  lines,
  terminalRecord,
  track,
} from "./testing.ts";
import { utf8Encode } from "./utf8.ts";

const LIST: ListResult = { terminals: [], hidden_finished: 0, machines: [] };
const T1 = terminalRecord("t1");
const T2 = terminalRecord("t2");
const IN_TRANSITION = "plain subscription transition in progress";
const NOTIFICATIONS_ONLY = "plain subscription is notification-only";

const event = (seq: number, terminal = "t1"): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: "event",
  params: { seq, type: "title", terminal, data: { title: `#${seq}` } },
});
const heartbeat = (seq: number) => ({ jsonrpc: "2.0", method: "heartbeat", params: { seq } });
const missed = (seq: number, terminals: unknown[]) => ({
  jsonrpc: "2.0",
  method: "missed",
  params: { seq, terminals },
});

async function opened(snapshot: EventSnapshot = { seq: 10, terminals: [] }) {
  const core = new FakeCore();
  core.snapshot = snapshot;
  await core.open();
  return core;
}

/** Callbacks that record what they get. */
function recorder() {
  const seen: string[] = [];
  const events: number[] = [];
  const snapshots: EventSnapshot[] = [];
  const beats: number[] = [];
  return {
    seen,
    events,
    snapshots,
    beats,
    callbacks: {
      onSnapshot: (snapshot: EventSnapshot) => {
        snapshots.push(snapshot);
        seen.push(`snapshot ${snapshot.seq}`);
      },
      onEvent: (e: HcEvent) => {
        events.push(e.seq);
        seen.push(`event ${e.seq}`);
      },
      onHeartbeat: (seq: number) => {
        beats.push(seq);
        seen.push(`heartbeat ${seq}`);
      },
    },
  };
}

/** A plain client whose subscription is in, with its writes captured. */
async function plainSubscribed(snapshot: EventSnapshot = { seq: 10, terminals: [] }) {
  const captured = capture();
  const record = recorder();
  const subscribing = captured.client.subscribeEvents({}, record.callbacks);
  await flush();
  captured.client.feed(line({ jsonrpc: "2.0", id: 1, result: snapshot }));
  return { ...captured, ...record, subscription: await subscribing };
}

describe("framed subscriptions", () => {
  test("send the filter exactly as given, field by field and combined", async () => {
    const filters: EventsSubscribeParams[] = [
      { terminal: "t7" },
      { children_of: "t3" },
      { labels: { "herdr.space": "s1", where: "phone" } },
      { terminal: "t7", children_of: "t3", labels: { "herdr.tab": "2" } },
    ];
    for (const filter of filters) {
      const core = await opened();
      await core.client.subscribeEvents(filter);
      expect(core.subscribed).toEqual([filter]);
    }
  });

  test("give the snapshot, then their channel's events in order across split and merged frames", async () => {
    const core = await opened({ seq: 10, terminals: [T1] });
    const record = recorder();
    const subscription = await core.client.subscribeEvents({ terminal: "t1" }, record.callbacks);
    expect(subscription.channel).toBe(1);
    expect(subscription.snapshot).toEqual({ seq: 10, terminals: [T1] });
    const bytes = lines(event(11), event(13), event(19));
    core.output(1, bytes.subarray(0, 25));
    core.output(1, bytes.subarray(25));
    expect(record.seen).toEqual(["snapshot 10", "event 11", "event 13", "event 19"]);
  });

  test("events sent ahead of the reply come after the snapshot", async () => {
    const core = new FakeCore();
    core.early = lines(event(11));
    await core.open();
    const record = recorder();
    await core.client.subscribeEvents({}, record.callbacks);
    expect(record.seen).toEqual(["snapshot 10", "event 11"]);
  });

  test("report heartbeat on its own", async () => {
    const core = await opened();
    const record = recorder();
    await core.client.subscribeEvents({}, record.callbacks);
    core.output(1, lines(heartbeat(42)));
    expect(record.beats).toEqual([42]);
    expect(record.events).toEqual([]);
  });

  test("missed replaces the snapshot and the baseline", async () => {
    const core = await opened({ seq: 10, terminals: [T1] });
    const record = recorder();
    const subscription = await core.client.subscribeEvents({}, record.callbacks);
    core.output(1, lines(event(11), missed(50, [T2]), event(50), event(51)));
    expect(record.snapshots.map((s) => s.terminals)).toEqual([[T1], [T2]]);
    expect(subscription.snapshot).toEqual({ seq: 50, terminals: [T2] });
    expect(record.events).toEqual([11, 51]);
  });

  test("drop events at or below the snapshot's seq", async () => {
    const core = await opened({ seq: 10, terminals: [] });
    const record = recorder();
    await core.client.subscribeEvents({}, record.callbacks);
    core.output(1, lines(event(9), event(10), event(11)));
    expect(record.events).toEqual([11]);
  });

  test("return credit as lines are read, so a line longer than the window still arrives", async () => {
    const core = await opened();
    const record = recorder();
    await core.client.subscribeEvents({}, record.callbacks);
    const long: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "event",
      params: { seq: 11, type: "title", terminal: "t1", data: { title: "x".repeat(300 * 1024) } },
    };
    const bytes = line(long);
    core.output(1, bytes);
    expect(record.events).toEqual([11]);
    expect(core.credits(1).reduce((sum, credit) => sum + credit, 0)).toBe(bytes.length);
  });

  test("several on one connection keep their own channels", async () => {
    const core = await opened();
    const a = recorder();
    const b = recorder();
    const first = await core.client.subscribeEvents({ terminal: "t1" }, a.callbacks);
    const second = await core.client.subscribeEvents({ terminal: "t2" }, b.callbacks);
    core.output(second.channel as number, lines(event(12, "t2")));
    core.output(first.channel as number, lines(event(11)));
    expect([a.events, b.events]).toEqual([[11], [12]]);
  });

  test("two clients keep their own snapshots and baselines", async () => {
    const high = await opened({ seq: 100, terminals: [] });
    const low = await opened({ seq: 2, terminals: [] });
    const h = recorder();
    const l = recorder();
    const hs = await high.client.subscribeEvents({}, h.callbacks);
    const ls = await low.client.subscribeEvents({}, l.callbacks);
    high.output(1, lines(missed(200, [])));
    low.output(1, lines(event(3)));
    expect(l.events).toEqual([3]);
    expect([hs.snapshot.seq, ls.snapshot.seq]).toEqual([200, 2]);
  });

  test("a subscription on a new connection starts from its own snapshot", async () => {
    const before = await opened({ seq: 100, terminals: [] });
    const old = recorder();
    await before.client.subscribeEvents({}, old.callbacks);
    before.output(1, lines(event(101)));
    before.client.end();
    const after = await opened({ seq: 2, terminals: [] });
    const fresh = recorder();
    await after.client.subscribeEvents({}, fresh.callbacks);
    after.output(1, lines(event(3)));
    expect([old.events, fresh.events]).toEqual([[101], [3]]);
  });

  test("a callback that throws doesn't stop the rest of the frame; feed rethrows it", async () => {
    const core = await opened();
    const events: number[] = [];
    await core.client.subscribeEvents(
      {},
      {
        onEvent: (e) => {
          events.push(e.seq);
          if (e.seq === 11) throw new Error("listener broke");
        },
      },
    );
    expect(() => core.output(1, lines(event(11), event(12)))).toThrow("listener broke");
    expect(events).toEqual([11, 12]);
    expect(core.credits(1)).toHaveLength(1);
    expect(core.client.isClosed).toBe(false);
  });

  test("an event line that isn't JSON ends the connection", async () => {
    const core = await opened();
    const subscription = await core.client.subscribeEvents({});
    core.output(1, utf8Encode("not json\n"));
    expect(core.client.isClosed).toBe(true);
    expect(await core.client.closed).toBeInstanceOf(ProtocolError);
    expect(await subscription.closed).toMatchObject({ kind: "transport" });
  });

  test("a framed reply without a channel ends the connection", async () => {
    const { client } = capture();
    const hello = client.hello();
    await flush();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 }));
    await hello;
    const subscribing = track(client.subscribeEvents({}));
    client.feed(frame({ jsonrpc: "2.0", id: 2, result: { seq: 1, terminals: [] } }));
    await flush();
    expect(subscribing.error).toBeInstanceOf(ProtocolError);
    expect(client.isClosed).toBe(true);
  });

  test("close sends one empty CLOSE and settles on the core's; later lines are dropped", async () => {
    const core = await opened();
    const record = recorder();
    const subscription = await core.client.subscribeEvents({}, record.callbacks);
    await subscription.close();
    await subscription.close();
    expect(core.frames(1, FrameKind.Close).map((f) => f.payload.length)).toEqual([0]);
    expect(await subscription.closed).toEqual({ kind: "detached" });
    core.send({ channel: 1, kind: FrameKind.Data, payload: lines(event(11)) });
    expect(record.events).toEqual([]);
  });

  test("call('events.subscribe') is refused", async () => {
    const core = await opened();
    const call = track(core.client.call("events.subscribe", {}));
    await flush();
    expect((call.error as Error).message).toBe("subscribe with subscribeEvents(), not call()");
  });
});

describe("plain subscriptions", () => {
  test("give their events to onEvent in order, gaps included", async () => {
    const { client, requests } = capture();
    const record = recorder();
    const subscribing = client.subscribeEvents({ labels: { where: "phone" } }, record.callbacks);
    await flush();
    expect(requests()).toEqual([
      { jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { labels: { where: "phone" } } },
    ]);
    client.feed(lines({ jsonrpc: "2.0", id: 1, result: { seq: 10, terminals: [] } }, event(11)));
    client.feed(lines(event(13), heartbeat(15), event(19)));
    const subscription = await subscribing;
    expect(subscription.channel).toBeUndefined();
    expect(record.seen).toEqual([
      "snapshot 10",
      "event 11",
      "event 13",
      "heartbeat 15",
      "event 19",
    ]);
  });

  test("wait for the calls already accepted before writing subscribe", async () => {
    const { client, requests } = capture();
    const first = track(client.call("terminal.list", {}));
    void client.subscribeEvents({ terminal: "t1" });
    await flush();
    expect(requests().map((request) => request.method)).toEqual(["terminal.list"]);
    client.feed(line({ jsonrpc: "2.0", id: 1, result: LIST }));
    await flush();
    expect(first.value).toEqual(LIST);
    expect(requests().map((request) => request.method)).toEqual([
      "terminal.list",
      "events.subscribe",
    ]);
  });

  test("refuse calls during the transition and after it, writing nothing", async () => {
    const { client, writes, requests } = capture();
    void client.call("terminal.list", {});
    const subscribing = track(client.subscribeEvents({}));
    const draining = track(client.call("terminal.get", { terminal: "t1" }));
    await flush();
    expect((draining.error as Error).message).toBe(IN_TRANSITION);
    expect(writes).toHaveLength(1);

    client.feed(line({ jsonrpc: "2.0", id: 1, result: LIST }));
    await flush();
    expect(writes).toHaveLength(2);
    const waiting = [client.call("doc.get", { name: "herdr-app" }), client.hello()].map((call) =>
      track(call as Promise<unknown>),
    );
    await flush();
    for (const state of waiting) expect((state.error as Error).message).toBe(IN_TRANSITION);
    expect(writes).toHaveLength(2);

    client.feed(line({ jsonrpc: "2.0", id: requests()[1]?.id, result: { seq: 5, terminals: [] } }));
    await flush();
    expect(subscribing.settled).toBe(true);
    const after = [
      client.call("terminal.list", {}),
      client.hello(),
      client.subscribeEvents({}),
    ].map((call) => track(call as Promise<unknown>));
    await flush();
    for (const state of after) expect((state.error as Error).message).toBe(NOTIFICATIONS_ONLY);
    expect(writes).toHaveLength(2);
    expect(client.acceptsCalls).toBe(false);
  });

  test("a subscribe error reply lets calls through again", async () => {
    const { client, writes } = capture();
    const subscribing = track(client.subscribeEvents({ terminal: "t9" }));
    await flush();
    const error = { code: -32000, message: "no terminal t9", data: { kind: "not_found" } };
    client.feed(line({ jsonrpc: "2.0", id: 1, error }));
    await flush();
    expect(subscribing.error).toBeInstanceOf(HcRpcError);
    const call = client.call("terminal.list", {});
    expect(writes).toHaveLength(2);
    client.feed(line({ jsonrpc: "2.0", id: 2, result: LIST }));
    expect(await call).toEqual(LIST);
  });

  test("close without requestTransportClose rejects and changes nothing", async () => {
    const { subscription, client } = await plainSubscribed();
    const closing = track(subscription.close());
    await flush();
    expect((closing.error as Error).message).toBe(
      "plain subscription close requires transport closure",
    );
    expect(client.isClosed).toBe(false);
  });

  test("close asks the caller once to close its transport, and a clean end settles it", async () => {
    let requested = 0;
    const client = createClient({
      write: () => {},
      requestTransportClose: () => {
        requested++;
      },
    });
    const subscribing = client.subscribeEvents({});
    await flush();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: { seq: 1, terminals: [] } }));
    const subscription = await subscribing;
    const first = track(subscription.close());
    const second = track(subscription.close());
    await flush();
    expect([requested, first.settled]).toEqual([1, false]);
    client.end();
    await flush();
    expect([first.settled, first.error, second.settled, second.error]).toEqual([
      true,
      undefined,
      true,
      undefined,
    ]);
    expect(await subscription.closed).toEqual({ kind: "detached" });
  });

  test("an end with an error rejects a pending close", async () => {
    const client = createClient({ write: () => {}, requestTransportClose: () => {} });
    const subscribing = client.subscribeEvents({});
    await flush();
    client.feed(line({ jsonrpc: "2.0", id: 1, result: { seq: 1, terminals: [] } }));
    const subscription = await subscribing;
    const closing = track(subscription.close());
    const reset = new Error("socket reset");
    client.end(reset);
    await flush();
    expect(closing.error).toBeInstanceOf(TransportClosedError);
    expect((closing.error as Error).cause).toBe(reset);
    expect(await subscription.closed).toEqual({ kind: "transport", cause: reset });
  });
});

describe("subscription lifetime", () => {
  test("end rejects a subscribe still waiting for its reply, plain or framed", async () => {
    const plain = capture();
    const plainSubscribing = track(plain.client.subscribeEvents({}));
    await flush();
    plain.client.end();

    const framed = capture();
    const hello = framed.client.hello();
    await flush();
    framed.client.feed(line({ jsonrpc: "2.0", id: 1, result: HC_0_1_16 }));
    await hello;
    const framedSubscribing = track(framed.client.subscribeEvents({}));
    framed.client.end();
    await flush();
    for (const state of [plainSubscribing, framedSubscribing]) {
      expect(state.error).toBeInstanceOf(TransportClosedError);
      expect((state.error as Error).message).toBe("hc connection closed");
    }
  });

  test("end rejects a framed close waiting for CLOSE, and closed settles once", async () => {
    const core = await opened();
    core.answerClose = false;
    const subscription = await core.client.subscribeEvents({});
    let closings = 0;
    subscription.closed.then(() => closings++);
    const closing = track(subscription.close());
    await flush();
    expect(closing.settled).toBe(false);
    core.client.end();
    core.client.end();
    await flush();
    expect(closing.error).toBeInstanceOf(TransportClosedError);
    expect((closing.error as Error).message).toBe("hc connection closed");
    expect(closings).toBe(1);
    expect(await subscription.closed).toEqual({ kind: "transport", cause: undefined });
  });

  test("input fed to an ended client changes nothing there or on a live one", async () => {
    const old = await opened({ seq: 100, terminals: [T1] });
    const oldRecord = recorder();
    const oldSubscription = await old.client.subscribeEvents({}, oldRecord.callbacks);
    old.client.end();
    const live = await opened({ seq: 2, terminals: [T2] });
    const liveRecord = recorder();
    const liveSubscription = await live.client.subscribeEvents({}, liveRecord.callbacks);

    old.client.feed(dataFrame(1, lines(missed(300, [terminalRecord("t9")]), event(301))));
    live.output(1, lines(event(3)));
    expect(oldRecord.seen).toEqual(["snapshot 100"]);
    expect(oldSubscription.snapshot).toEqual({ seq: 100, terminals: [T1] });
    expect(liveRecord.seen).toEqual(["snapshot 2", "event 3"]);
    expect(liveSubscription.snapshot).toEqual({ seq: 2, terminals: [T2] });
  });
});
