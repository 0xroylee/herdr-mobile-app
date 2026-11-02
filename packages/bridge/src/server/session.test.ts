import { describe, expect, test } from "bun:test";
import { FakeCore, flush, line } from "@herdr-mobile/hc-client/testing";
import { BRIDGE_WS_CLOSE_CODES } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";
import { startSession } from "./session.ts";
import type { Socket } from "./socket.ts";

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await flush();
}

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

class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | undefined;
  private messageListener: ((bytes: Uint8Array) => void) | undefined;
  private closeListener: (() => void) | undefined;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.closeListener?.();
  }

  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  message(bytes: Uint8Array): void {
    this.messageListener?.(bytes);
  }

  remoteClose(): void {
    this.closeListener?.();
  }
}

class FakeConnect implements OwnedProcess {
  readonly core: FakeCore;
  readonly exited: Promise<number | null>;
  inputClosed = false;
  killed = false;
  exitOnClose = false;
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onEnd: (() => void) | undefined;
  private resolveExit: (code: number | null) => void = () => {};
  private ended = false;

  constructor() {
    this.core = new FakeCore((bytes) => this.onData?.(bytes));
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): void | Promise<void> {
    if (!this.ended) return this.core.write(bytes);
  }

  closeInput(): void {
    this.inputClosed = true;
    if (this.exitOnClose) this.exit(0);
  }

  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    this.onData = onData;
    this.onEnd = onEnd;
    if (this.ended) onEnd();
  }

  kill(): void {
    this.killed = true;
    this.exit(null);
  }

  exit(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd?.();
    this.resolveExit(code);
  }
}

class FakeRunner implements ProcessRunner {
  readonly child = new FakeConnect();
  spawnArgs: string[] | undefined;
  spawnEnv: Record<string, string> | undefined;
  spawnCwd: string | undefined;

  spawn(argv: string[], options: { env: Record<string, string>; cwd: string }): OwnedProcess {
    this.spawnArgs = argv;
    this.spawnEnv = options.env;
    this.spawnCwd = options.cwd;
    return this.child;
  }
}

const env: Env = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/tester",
  LANG: "en_US.UTF-8",
  HC_SOCKET: "/tmp/real-core.sock",
  HC_TERMINAL_ID: "real-terminal",
  HC_TERMINAL_SOCKET: "/tmp/real-terminal.sock",
  HC_SCOPE: "real-scope",
  HC_RUNTIME: "/tmp/real-runtime",
};

describe("startSession", () => {
  test("starts hc connect with an isolated env and gates phone requests", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    startSession({
      socket,
      runner,
      clock: new FakeClock(),
      env,
      role: "control",
      session: "test-run",
    });

    expect(runner.spawnArgs).toEqual(["hc", "connect"]);
    expect(runner.spawnCwd).toBe("/Users/tester");
    expect(runner.spawnEnv).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
      HC_SESSION: "test-run",
    });

    socket.message(line({ jsonrpc: "2.0", id: 1, method: "server.stop" }));
    expect(runner.child.core.calls).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(socket.sent[0]))).toMatchObject({
      id: 1,
      error: { data: { kind: "forbidden" } },
    });

    socket.message(line({ jsonrpc: "2.0", id: 2, method: "hello", params: { framed: true } }));
    await settle();
    expect(runner.child.core.calls).toEqual(["hello"]);
    expect(socket.sent).toHaveLength(2);
  });

  test("socket close closes child stdin and kills after five seconds", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    const clock = new FakeClock();
    startSession({ socket, runner, clock, env, role: "watch" });

    socket.remoteClose();
    await settle();
    expect(runner.child.inputClosed).toBe(true);
    await clock.advance(4_999);
    expect(runner.child.killed).toBe(false);
    await clock.advance(1);
    expect(runner.child.killed).toBe(true);
  });

  test("socket close ends stdin immediately and kills after five seconds with a stalled write", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    const clock = new FakeClock();
    runner.child.write = () => new Promise<void>(() => {});
    startSession({ socket, runner, clock, env, role: "watch" });

    socket.message(line({ jsonrpc: "2.0", id: 1, method: "server.status" }));
    await settle();
    socket.remoteClose();
    expect(runner.child.inputClosed).toBe(true);
    await clock.advance(4_999);
    expect(runner.child.killed).toBe(false);
    await clock.advance(1);
    expect(runner.child.killed).toBe(true);
  });

  test("child exit during a stalled write prevents a later kill", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    const clock = new FakeClock();
    runner.child.write = () => new Promise<void>(() => {});
    startSession({ socket, runner, clock, env, role: "watch" });

    socket.message(line({ jsonrpc: "2.0", id: 1, method: "server.status" }));
    await settle();
    socket.remoteClose();
    await settle();
    expect(runner.child.inputClosed).toBe(true);
    runner.child.exit(1);
    await settle();
    await clock.advance(5_000);
    expect(runner.child.killed).toBe(false);
  });

  test("a failed write closes the socket and does not send queued work to the core", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    let writes = 0;
    runner.child.write = async (bytes) => {
      writes++;
      if (writes === 1) {
        await runner.child.core.write(bytes);
        throw new Error("broken pipe");
      }
      return runner.child.core.write(bytes);
    };
    startSession({ socket, runner, clock: new FakeClock(), env, role: "control" });

    socket.message(line({ jsonrpc: "2.0", id: 1, method: "server.status" }));
    socket.message(
      line({ jsonrpc: "2.0", id: 2, method: "terminal.kill", params: { terminal: "t1" } }),
    );
    await settle();

    expect(socket.closed?.code).toBe(BRIDGE_WS_CLOSE_CODES.CHILD_EXITED);
    expect(runner.child.core.calls).toEqual(["server.status"]);
    expect(writes).toBe(1);
    expect(runner.child.inputClosed).toBe(true);
    runner.child.exit(1);
    await settle();
  });

  test("child exit closes the socket with 1011", async () => {
    const socket = new FakeSocket();
    const runner = new FakeRunner();
    startSession({ socket, runner, clock: new FakeClock(), env, role: "watch" });

    runner.child.exit(1);
    await settle();
    expect(socket.closed).toEqual({
      code: BRIDGE_WS_CLOSE_CODES.CHILD_EXITED,
      reason: "hc connect exited",
    });
    expect(runner.child.inputClosed).toBe(true);
  });
});
