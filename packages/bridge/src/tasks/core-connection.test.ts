import { describe, expect, test } from "bun:test";
import { FakeCore, flush, line } from "@herdr-mobile/hc-client/testing";
import { FrameKind, type Terminal } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import {
  CORE_CONNECTION_CLOSE_MS,
  CORE_CONNECTION_EXIT_GRACE_MS,
  CORE_CONNECTION_RECONNECT_MS,
  CORE_CONNECTION_STAGE_MS,
  CORE_CONNECTION_STALE_MS,
  CoreConnection,
  type CoreConnectionEndObservation,
  type CoreConnectionStatus,
  classifyEnd,
} from "./core-connection.ts";

class FakeClock implements Clock {
  private current = 1_000;
  private nextId = 1;
  private readonly timers: { at: number; id: number; callback: () => void }[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.current + ms, id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const index = this.timers.findIndex((timer) => timer.id === handle);
    if (index >= 0) this.timers.splice(index, 1);
  }

  get nextDelay(): number | undefined {
    const next = this.timers.sort((left, right) => left.at - right.at || left.id - right.id)[0];
    return next === undefined ? undefined : next.at - this.current;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const timer = this.timers
        .filter(({ at }) => at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!timer) break;
      this.timers.splice(this.timers.indexOf(timer), 1);
      this.current = timer.at;
      timer.callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

class FakeConnect implements OwnedProcess {
  readonly core: FakeCore;
  readonly exited: Promise<number | null>;
  readonly argv: string[];
  readonly options: { env: Record<string, string>; cwd: string };
  inputClosed = false;
  killed = false;
  ignoreClose = false;
  ignoreKill = false;
  ended = false;
  outputClosed = false;
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onEnd: (() => void) | undefined;
  private resolveExit: (code: number | null) => void = () => {};

  constructor(argv: string[], options: { env: Record<string, string>; cwd: string }) {
    this.argv = argv;
    this.options = options;
    this.core = new FakeCore((bytes) => this.onData?.(bytes));
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): void | Promise<void> {
    return this.core.write(bytes);
  }

  closeInput(): void {
    this.inputClosed = true;
    if (!this.ignoreClose) this.exit(0);
  }

  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    this.onData = onData;
    this.onEnd = onEnd;
    if (this.outputClosed) onEnd();
  }

  kill(): void {
    this.killed = true;
    if (!this.ignoreKill) this.exit(null);
  }

  exit(code: number | null, closeOutput = true): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveExit(code);
    if (closeOutput) this.closeOutput();
  }

  closeOutput(): void {
    if (this.outputClosed) return;
    this.outputClosed = true;
    this.onEnd?.();
  }
}

class FakeRunner implements ProcessRunner {
  readonly children: FakeConnect[] = [];
  failSpawn = false;
  holdMethod: string | undefined;
  snapshot: { seq: number; terminals: Terminal[] } | undefined;
  maxAlive = 0;

  spawn(argv: string[], options: { env: Record<string, string>; cwd: string }): OwnedProcess {
    if (this.failSpawn) throw new Error("hc connect is missing");
    const child = new FakeConnect(argv, options);
    if (this.snapshot) child.core.snapshot = structuredClone(this.snapshot);
    if (this.holdMethod) child.core.hold(this.holdMethod);
    this.children.push(child);
    this.maxAlive = Math.max(this.maxAlive, this.alive);
    return child;
  }

  get alive(): number {
    return this.children.filter((child) => !child.ended).length;
  }
}

const terminal = (address: string, state = "live"): Terminal =>
  ({
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1,
    cwd: "/repo",
    labels: {},
    rows: 24,
    screen: "exact",
    state,
  }) as Terminal;

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await flush();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await settle();
    if (predicate()) return;
  }
  throw new Error("condition did not settle");
}

async function stopWithFakeClock(connection: CoreConnection, clock: FakeClock): Promise<void> {
  const stopping = connection.stop();
  for (let index = 0; index < 3 && connection.status().state === "stopping"; index += 1) {
    await settle();
    const delay = clock.nextDelay;
    if (delay === undefined) break;
    await clock.advance(delay);
  }
  await stopping;
}

function makeConnection(
  options: {
    runner?: FakeRunner;
    clock?: FakeClock;
    random?: () => number;
    onSnapshot?: (snapshot: { seq: number; terminals: Terminal[] }) => void;
    onEvent?: (event: { seq: number; type: string }) => void;
    onState?: (status: CoreConnectionStatus) => void;
  } = {},
) {
  const runner = options.runner ?? new FakeRunner();
  const clock = options.clock ?? new FakeClock();
  const states: CoreConnectionStatus[] = [];
  const connection = new CoreConnection(
    {
      runner,
      hcPath: "/fake/hc",
      session: "scratch-core",
      env: { HOME: "/scratch", PATH: "/bin", HC_SESSION: "wrong-session" },
      cwd: "/scratch/repo",
      clock,
      ...(options.random === undefined ? {} : { random: options.random }),
    },
    {
      onSnapshot: options.onSnapshot ?? (() => {}),
      onEvent: options.onEvent ?? (() => {}),
      onState: (status) => {
        states.push(status);
        options.onState?.(status);
      },
    },
  );
  return { runner, clock, connection, states };
}

async function connectLive(connection: CoreConnection, runner: FakeRunner): Promise<FakeConnect> {
  connection.start();
  await waitFor(() => connection.status().state === "live");
  const child = runner.children.at(-1);
  if (!child) throw new Error("hc connect child did not spawn");
  return child;
}

function notify(child: FakeConnect, channel: number, method: string, params: unknown): void {
  child.core.send({
    channel,
    kind: FrameKind.Data,
    payload: line({ jsonrpc: "2.0", method, params }),
  });
}

describe("CoreConnection", () => {
  test.each([
    {
      name: "requires a successful subscription",
      observation: {
        subscribed: false,
        trigger: "exit",
        exitedNaturally: true,
        exitCode: 0,
        serverStopComplete: true,
      },
      expected: "backoff",
    },
    {
      name: "watchdog always backs off",
      observation: {
        subscribed: true,
        trigger: "watchdog",
        exitedNaturally: true,
        exitCode: 0,
        serverStopComplete: true,
      },
      expected: "backoff",
    },
    {
      name: "client errors always back off",
      observation: {
        subscribed: true,
        trigger: "client-error",
        exitedNaturally: true,
        exitCode: 0,
        serverStopComplete: true,
      },
      expected: "backoff",
    },
    {
      name: "requires a natural exit within the grace period",
      observation: {
        subscribed: true,
        trigger: "exit",
        exitedNaturally: false,
        exitCode: 0,
        serverStopComplete: true,
      },
      expected: "backoff",
    },
    {
      name: "parks on a natural zero exit",
      observation: {
        subscribed: true,
        trigger: "output-close",
        exitedNaturally: true,
        exitCode: 0,
        serverStopComplete: false,
      },
      expected: "parked",
    },
    {
      name: "parks when every live terminal stopped with the server",
      observation: {
        subscribed: true,
        trigger: "subscription-end",
        exitedNaturally: true,
        exitCode: 2,
        serverStopComplete: true,
      },
      expected: "parked",
    },
    {
      name: "a nonzero exit without complete evidence backs off",
      observation: {
        subscribed: true,
        trigger: "exit",
        exitedNaturally: true,
        exitCode: 2,
        serverStopComplete: false,
      },
      expected: "backoff",
    },
  ] as const)("classifies end observations: $name", ({ observation, expected }) => {
    expect(classifyEnd(observation as CoreConnectionEndObservation)).toBe(expected);
  });

  test("spawns a framed connection, snapshots before events, and forwards missed snapshots", async () => {
    const order: string[] = [];
    const snapshots: number[] = [];
    const events: number[] = [];
    const { runner, clock, connection } = makeConnection({
      onSnapshot: (snapshot) => {
        order.push("snapshot");
        snapshots.push(snapshot.seq);
      },
      onEvent: (event) => {
        order.push("event");
        events.push(event.seq);
      },
    });
    const child = await connectLive(connection, runner);

    expect(child.argv).toEqual(["/fake/hc", "connect"]);
    expect(child.options).toEqual({
      cwd: "/scratch/repo",
      env: { HOME: "/scratch", PATH: "/bin", HC_SESSION: "scratch-core" },
    });
    expect(child.core.calls).toEqual(["hello", "events.subscribe"]);
    expect(child.core.subscribed).toEqual([{}]);
    expect(snapshots).toEqual([10]);
    expect(connection.status()).toMatchObject({ state: "live", seq: 10, reconnects: 0 });

    const channel = child.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    notify(child, channel, "event", { seq: 11, type: "status", terminal: "t1", data: {} });
    notify(child, channel, "missed", { seq: 20, terminals: [terminal("t2")] });
    notify(child, channel, "event", { seq: 21, type: "turn", terminal: "t2", data: { turn: 1 } });

    expect(snapshots).toEqual([10, 20]);
    expect(events).toEqual([11, 21]);
    expect(order).toEqual(["snapshot", "event", "snapshot", "event"]);
    expect(connection.status().seq).toBe(21);
    await stopWithFakeClock(connection, clock);
  });

  test("backs off on child exit with jitter and follows the capped schedule", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.25 });
    const base = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

    for (const duration of base) {
      const child = await connectLive(connection, runner);
      child.exit(1);
      await waitFor(() => connection.status().state === "backoff");
      const delay = clock.nextDelay;
      expect(delay).toBeGreaterThanOrEqual(duration * 0.8);
      expect(delay).toBeLessThanOrEqual(duration * 1.2);
      await clock.advance(delay ?? 0);
      expect(runner.alive).toBeLessThanOrEqual(1);
    }

    expect(runner.maxAlive).toBeLessThanOrEqual(1);
    await stopWithFakeClock(connection, clock);
  });

  test("resets backoff on its first heartbeat after subscribing", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const first = await connectLive(connection, runner);
    first.exit(1);
    await waitFor(() => connection.status().state === "backoff");
    await clock.advance(1_000);
    const second = await connectLive(connection, runner);
    const channel = second.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    notify(second, channel, "heartbeat", { seq: 12 });
    second.exit(1);
    await waitFor(() => connection.status().state === "backoff");
    expect(clock.nextDelay).toBe(1_000);
    await stopWithFakeClock(connection, clock);
  });

  test("marks stale at 40 seconds and kills/reconnects at 60 seconds", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const child = await connectLive(connection, runner);

    await clock.advance(CORE_CONNECTION_STALE_MS);
    expect(connection.status().state).toBe("stale");
    expect(runner.children).toHaveLength(1);
    await clock.advance(CORE_CONNECTION_RECONNECT_MS - CORE_CONNECTION_STALE_MS);
    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");
    expect(child.killed).toBe(true);
    expect(connection.status().lastError).toContain("watchdog");
    expect(runner.alive).toBe(0);
    await clock.advance(1_000);
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    await stopWithFakeClock(connection, clock);
  });

  test("reports a spawn failure and rejects calls until the long connection is live", async () => {
    const runner = new FakeRunner();
    runner.failSpawn = true;
    const { clock, connection } = makeConnection({ runner, random: () => 0.5 });
    connection.start();
    await waitFor(() => connection.status().state === "backoff");
    expect(connection.status().lastError).toContain("hc connect is missing");
    await expect(connection.call("doc.get", { name: "herdr-mobile.tasks" })).rejects.toThrow(
      "core connection is not live",
    );

    runner.failSpawn = false;
    await clock.advance(1_000);
    const child = await connectLive(connection, runner);
    child.core.answer = (method) =>
      method === "doc.get" ? { value: null, version: 0 } : undefined;
    await expect(connection.call("doc.get", { name: "herdr-mobile.tasks" })).resolves.toEqual({
      value: null,
      version: 0,
    });
    expect(connection.status()).toMatchObject({ state: "live", seq: 10, reconnects: 1 });
    await stopWithFakeClock(connection, clock);
  });

  test("parks after server_stop and resumes immediately when asked", async () => {
    const runner = new FakeRunner();
    runner.snapshot = { seq: 10, terminals: [terminal("t1"), terminal("t2")] };
    const { clock, connection } = makeConnection({ runner, random: () => 0.5 });
    const liveChild = await connectLive(connection, runner);
    const channel = liveChild.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    notify(liveChild, channel, "event", {
      seq: 11,
      type: "finished",
      terminal: "t1",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
    });
    notify(liveChild, channel, "event", {
      seq: 12,
      type: "finished",
      terminal: "t2",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 3 },
    });
    liveChild.exit(2);
    await waitFor(() => connection.status().state === "parked");
    expect(runner.children).toHaveLength(1);
    await clock.advance(30_000);
    expect(runner.children).toHaveLength(1);

    connection.resume();
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    await stopWithFakeClock(connection, clock);
  });

  test.each([
    {
      name: "one live terminal remains",
      events: [
        {
          seq: 11,
          type: "finished",
          terminal: "t1",
          data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
        },
      ],
    },
    {
      name: "one terminal finished without server_stop",
      events: [
        {
          seq: 11,
          type: "finished",
          terminal: "t1",
          data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
        },
        {
          seq: 12,
          type: "finished",
          terminal: "t2",
          data: { reason: "exited", exit_code: 1, signal: null, finished_ms: 3 },
        },
      ],
    },
  ])("backs off when server_stop event evidence is incomplete: $name", async ({ events }) => {
    const runner = new FakeRunner();
    runner.snapshot = { seq: 10, terminals: [terminal("t1"), terminal("t2")] };
    const { clock, connection } = makeConnection({ runner, random: () => 0.5 });
    const child = await connectLive(connection, runner);
    const channel = child.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    for (const event of events) notify(child, channel, "event", event);

    child.exit(2);
    await waitFor(() => connection.status().state === "backoff");
    expect(connection.status().state).toBe("backoff");
    await stopWithFakeClock(connection, clock);
  });

  test("keeps delivering final events after exit settles before stdout closes", async () => {
    const runner = new FakeRunner();
    runner.snapshot = { seq: 10, terminals: [terminal("t1"), terminal("t2")] };
    const delivered: number[] = [];
    const { clock, connection } = makeConnection({
      runner,
      onEvent: (event) => delivered.push(event.seq),
    });
    const child = await connectLive(connection, runner);
    const channel = child.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");

    child.exit(2, false);
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);
    notify(child, channel, "event", {
      seq: 11,
      type: "finished",
      terminal: "t1",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
    });
    notify(child, channel, "event", {
      seq: 12,
      type: "finished",
      terminal: "t2",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 3 },
    });
    child.closeOutput();

    await waitFor(() => connection.status().state === "parked");
    expect(delivered).toEqual([11, 12]);
    expect(child.killed).toBe(false);
    await stopWithFakeClock(connection, clock);
  });

  test("backs off when complete server-stop evidence outlives the exit grace", async () => {
    const runner = new FakeRunner();
    runner.snapshot = { seq: 10, terminals: [terminal("t1")] };
    const { clock, connection } = makeConnection({ runner, random: () => 0.5 });
    const child = await connectLive(connection, runner);
    const channel = child.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    notify(child, channel, "event", {
      seq: 11,
      type: "finished",
      terminal: "t1",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
    });
    child.ignoreClose = true;
    child.ignoreKill = true;
    child.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);

    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");
    expect(child.killed).toBe(true);
    expect(runner.alive).toBe(1);
    child.exit(null);
    await stopWithFakeClock(connection, clock);
  });

  test("watchdog ends back off even with complete server-stop evidence", async () => {
    const runner = new FakeRunner();
    runner.snapshot = { seq: 10, terminals: [terminal("t1")] };
    const { clock, connection } = makeConnection({ runner, random: () => 0.5 });
    const child = await connectLive(connection, runner);
    const channel = child.core.opened.subscribe[0];
    if (channel === undefined) throw new Error("subscription channel missing");
    notify(child, channel, "event", {
      seq: 11,
      type: "finished",
      terminal: "t1",
      data: { reason: "server_stop", exit_code: null, signal: null, finished_ms: 2 },
    });
    child.ignoreClose = true;
    child.ignoreKill = true;

    await clock.advance(CORE_CONNECTION_STALE_MS);
    expect(connection.status().state).toBe("stale");
    await clock.advance(CORE_CONNECTION_RECONNECT_MS - CORE_CONNECTION_STALE_MS);
    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");
    expect(connection.status().lastError).toContain("watchdog");
    expect(child.killed).toBe(true);
    child.exit(null);
    await stopWithFakeClock(connection, clock);
  });

  test("parks when an empty core exits naturally with code zero", async () => {
    const { runner, clock, connection } = makeConnection();
    const child = await connectLive(connection, runner);

    child.exit(0);
    await waitFor(() => connection.status().state === "parked");
    await clock.advance(30_000);

    expect(runner.children).toHaveLength(1);
    expect(connection.status().reconnects).toBe(0);
    await stopWithFakeClock(connection, clock);
  });

  test("waits for a zero child exit after stdout closes before parking", async () => {
    const { runner, clock, connection } = makeConnection();
    const child = await connectLive(connection, runner);

    child.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);
    child.exit(0, false);
    await waitFor(() => connection.status().state === "parked");

    expect(child.killed).toBe(false);
    expect(connection.status().reconnects).toBe(0);
    await connection.stop();
  });

  test("backs off when stdout closes before a nonzero child exit", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const child = await connectLive(connection, runner);

    child.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);
    child.exit(7, false);
    await waitFor(() => connection.status().state === "backoff");

    expect(child.killed).toBe(false);
    expect(connection.status().reconnects).toBe(1);
    await connection.stop();
  });

  test("kills and backs off when the child does not exit during the stdout grace period", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const child = await connectLive(connection, runner);
    child.ignoreClose = true;
    child.ignoreKill = true;

    child.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);
    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");

    expect(child.killed).toBe(true);
    expect(runner.children).toHaveLength(1);
    expect(runner.alive).toBe(1);
    child.exit(null);
    await connection.stop();
  });

  test("backs off after non-server_stop ends and stop closes and kills on deadline", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const child = await connectLive(connection, runner);
    child.exit(2);
    await waitFor(() => connection.status().state === "backoff");
    expect(connection.status().lastError).toContain("exited with 2");
    await clock.advance(1_000);
    const current = await connectLive(connection, runner);
    current.ignoreClose = true;

    const stopping = connection.stop();
    await settle();
    expect(current.inputClosed).toBe(false);
    await clock.advance(1_000);
    await settle();
    expect(current.inputClosed).toBe(true);
    expect(current.core.calls).toEqual(["hello", "events.subscribe"]);
    expect(
      current.core.frames(current.core.opened.subscribe[0] ?? 0, FrameKind.Close),
    ).toHaveLength(1);
    await clock.advance(4_999);
    expect(current.killed).toBe(false);
    await clock.advance(1);
    await stopping;
    expect(current.inputClosed).toBe(true);
    expect(current.killed).toBe(true);
    expect(connection.status().state).toBe("stopped");
    expect(runner.alive).toBe(0);
  });

  test("stopping a healthy connection closes its input without a second child", async () => {
    const { runner, clock, connection } = makeConnection();
    const child = await connectLive(connection, runner);
    await stopWithFakeClock(connection, clock);

    expect(child.inputClosed).toBe(true);
    expect(child.killed).toBe(false);
    expect(runner.children).toHaveLength(1);
    expect(runner.alive).toBe(0);
    expect(connection.status().state).toBe("stopped");
    expect(connection.status().since).toBeGreaterThan(0);
    expect(connection.status().lastEventAt).toBeGreaterThan(0);
  });

  test("cancels a grace wait and lets a queued start own its timers", async () => {
    const { runner, clock, connection } = makeConnection();
    const oldChild = await connectLive(connection, runner);
    oldChild.ignoreClose = true;
    oldChild.ignoreKill = true;
    oldChild.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);

    const stopping = connection.stop();
    await clock.advance(1_000);
    await settle();
    expect(oldChild.inputClosed).toBe(true);
    await clock.advance(5_000);
    await stopping;
    expect(connection.status().state).toBe("stopped");
    expect(oldChild.killed).toBe(true);

    oldChild.exit(0, false);
    await settle();
    expect(connection.status().state).toBe("stopped");
    expect(runner.children).toHaveLength(1);

    connection.start();
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    expect(runner.maxAlive).toBe(1);
    expect(clock.nextDelay).toBe(CORE_CONNECTION_STALE_MS);

    oldChild.closeOutput();
    expect(connection.status().state).toBe("live");
    expect(clock.nextDelay).toBe(CORE_CONNECTION_STALE_MS);
    await stopWithFakeClock(connection, clock);
  });

  test("does not park when a zero exit settles during stop's cancelled stdout grace", async () => {
    const { runner, clock, connection, states } = makeConnection();
    const oldChild = await connectLive(connection, runner);
    oldChild.ignoreClose = true;
    oldChild.closeOutput();
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);

    const stopping = connection.stop();
    oldChild.exit(0, false);
    await clock.advance(CORE_CONNECTION_CLOSE_MS);
    await stopping;
    await settle();

    expect(connection.status().state).toBe("stopped");
    expect(states.map(({ state }) => state)).not.toContain("parked");

    connection.start();
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    await settle();
    expect(connection.status().state).toBe("live");
    await stopWithFakeClock(connection, clock);
  });

  test("ignores old output and events after stop and restart", async () => {
    const forwarded: number[] = [];
    const { runner, clock, connection } = makeConnection({
      random: () => 0.5,
      onEvent: (event) => forwarded.push(event.seq),
    });
    const oldChild = await connectLive(connection, runner);
    const oldChannel = oldChild.core.opened.subscribe[0];
    if (oldChannel === undefined) throw new Error("old subscription channel missing");

    oldChild.exit(1, false);
    await waitFor(() => clock.nextDelay === CORE_CONNECTION_EXIT_GRACE_MS);
    const stopping = connection.stop();
    notify(oldChild, oldChannel, "event", {
      seq: 98,
      type: "status",
      terminal: "late-during-stop",
      data: { state: "done" },
    });
    await settle();
    await clock.advance(CORE_CONNECTION_CLOSE_MS);
    await stopping;
    expect(connection.status().state).toBe("stopped");
    expect(oldChild.outputClosed).toBe(false);

    connection.start();
    await waitFor(() => connection.status().state === "live");
    const currentChild = runner.children.at(-1);
    if (!currentChild || currentChild === oldChild) throw new Error("replacement child missing");
    const currentChannel = currentChild.core.opened.subscribe[0];
    if (currentChannel === undefined) throw new Error("replacement subscription channel missing");
    notify(currentChild, currentChannel, "heartbeat", { seq: 11 });
    await settle();

    const lastEventAt = connection.status().lastEventAt;
    const nextDelay = clock.nextDelay;
    expect(nextDelay).toBe(CORE_CONNECTION_STALE_MS);
    notify(oldChild, oldChannel, "event", {
      seq: 99,
      type: "status",
      terminal: "late-terminal",
      data: { state: "done" },
    });
    oldChild.closeOutput();
    await settle();

    expect(oldChild.outputClosed).toBe(true);
    expect(forwarded).toEqual([]);
    expect(connection.status()).toMatchObject({ state: "live", seq: 11, lastEventAt });
    expect(clock.nextDelay).toBe(nextDelay);

    await clock.advance(CORE_CONNECTION_STALE_MS - 1);
    expect(connection.status().state).toBe("live");
    await clock.advance(1);
    expect(connection.status().state).toBe("stale");
    await clock.advance(CORE_CONNECTION_RECONNECT_MS - CORE_CONNECTION_STALE_MS);
    expect(connection.status().state).toBe("stale");
    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");
    expect(currentChild.killed).toBe(true);

    await clock.advance(1_000);
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(3);
    await stopWithFakeClock(connection, clock);
  });

  test("keeps a killed child owned until it exits before starting again", async () => {
    const { runner, clock, connection } = makeConnection();
    const child = await connectLive(connection, runner);
    child.ignoreClose = true;
    child.ignoreKill = true;

    const stopping = connection.stop();
    await clock.advance(1_000);
    await waitFor(() => child.inputClosed);
    await clock.advance(5_000);
    await stopping;
    expect(child.killed).toBe(true);
    expect(connection.status().state).toBe("stopped");
    expect(runner.alive).toBe(1);

    connection.start();
    await settle();
    expect(runner.children).toHaveLength(1);
    expect(runner.maxAlive).toBe(1);

    child.exit(null);
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    expect(runner.maxAlive).toBe(1);
    await stopWithFakeClock(connection, clock);
  });

  test("gates a watchdog reconnect until the previous child exits", async () => {
    const { runner, clock, connection } = makeConnection({ random: () => 0.5 });
    const child = await connectLive(connection, runner);
    child.ignoreClose = true;
    child.ignoreKill = true;

    await clock.advance(CORE_CONNECTION_STALE_MS);
    await clock.advance(CORE_CONNECTION_RECONNECT_MS - CORE_CONNECTION_STALE_MS);
    await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
    await waitFor(() => connection.status().state === "backoff");
    expect(child.killed).toBe(true);

    await clock.advance(1_000);
    expect(runner.children).toHaveLength(1);
    expect(runner.alive).toBe(1);
    expect(runner.maxAlive).toBe(1);

    child.exit(null);
    await waitFor(() => connection.status().state === "live");
    expect(runner.children).toHaveLength(2);
    expect(runner.maxAlive).toBe(1);
    await stopWithFakeClock(connection, clock);
  });

  test.each(["hello", "events.subscribe"] as const)(
    "applies the ten-second deadline to %s",
    async (method) => {
      const runner = new FakeRunner();
      runner.holdMethod = method;
      const { clock, connection } = makeConnection({ runner });
      connection.start();
      await waitFor(() => runner.children.length === 1);
      await clock.advance(CORE_CONNECTION_STAGE_MS);
      await clock.advance(CORE_CONNECTION_EXIT_GRACE_MS);
      await waitFor(() => connection.status().state === "backoff");

      expect(runner.children[0]?.killed).toBe(true);
      expect(connection.status().lastError).toContain("deadline exceeded");
      await connection.stop();
    },
  );
});
