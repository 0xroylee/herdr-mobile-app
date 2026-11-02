// The prototype against fakes: a controlled clock, a recording filesystem, `hc connect` children
// backed by hc-client's FakeCore, and a renderer whose callbacks can be held. Nothing here
// starts a real core.

import { describe, expect, test } from "bun:test";
import { FakeCore, flush, lines, track } from "@herdr-mobile/hc-client/testing";
import { FrameKind, type Terminal } from "@herdr-mobile/protocol";
import type { Clock } from "./deadline.ts";
import type { OwnedProcess, ProcessRunner } from "./process.ts";
import type { Renderer } from "./renderer.ts";
import {
  createScratchContext,
  type Env,
  isolationProblem,
  type ScratchContext,
  type ScratchFs,
  scratchEnv,
  spawnScratchConnect,
} from "./scratch.ts";
import { CLEANUP_MS, RUN_LABEL, runPrototype, STAGE_MS } from "./workflow.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION = "hmp-test";
const ROOT = "/tmp/hmp-test";
const LABELS = { [RUN_LABEL]: SESSION };
const FIXTURE = { address: "t1", labels: LABELS } as unknown as Terminal;
const POISONED: Env = {
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  HOME: "/Users/someone",
  HC_SOCKET: "/Users/someone/.local/state/herdr-core/default/default.sock",
  HC_TERMINAL_ID: "t99",
  HC_SESSION: "default",
  XDG_STATE_HOME: "/Users/someone/.local/state",
  API_TOKEN: "secret",
};
const SCRATCH_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  HC_SESSION: SESSION,
  HOME: `${ROOT}/home`,
  XDG_RUNTIME_DIR: `${ROOT}/run`,
  XDG_STATE_HOME: `${ROOT}/state`,
  XDG_CONFIG_HOME: `${ROOT}/config`,
};

/** Lets every promise callback and queued microtask run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await flush();
}

class FakeClock implements Clock {
  private time = 1_000_000;
  private timers: { at: number; id: number; callback: () => void }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Moves time on by `ms`, firing each timer as it comes due, with callbacks run in between. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await settle();
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

class FakeFs implements ScratchFs {
  readonly made: string[] = [];
  readonly written: string[] = [];
  readonly removed: string[] = [];
  onWrite: (path: string) => void = () => {};

  makeTempDir(prefix: string): string {
    const path = `${prefix}test`;
    this.made.push(path);
    return path;
  }

  makeDir(path: string): void {
    this.made.push(path);
  }

  writeFile(path: string): void {
    this.written.push(path);
    this.onWrite(path);
  }

  remove(path: string): void {
    this.removed.push(path);
  }
}

/** An `hc connect` child whose core is a FakeCore. It exits when its stdin closes, as hc does. */
class FakeConnect implements OwnedProcess {
  readonly core: FakeCore;
  readonly exited: Promise<number | null>;
  exitOnClose = true;
  killed = false;
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onEnd: (() => void) | undefined;
  private early: Uint8Array[] = [];
  private ended = false;
  private resolveExit: (code: number | null) => void = () => {};

  constructor() {
    this.core = new FakeCore((bytes) => this.stdout(bytes));
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): void | Promise<void> {
    if (!this.ended) return this.core.write(bytes);
  }

  closeInput(): void {
    if (this.exitOnClose) this.exit(0);
  }

  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    this.onData = onData;
    this.onEnd = onEnd;
    for (const bytes of this.early.splice(0)) onData(bytes);
    if (this.ended) onEnd();
  }

  kill(): void {
    this.killed = true;
    this.exit(null);
  }

  /** Ends stdout and exits, as hc connect does once the core goes away. */
  exit(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd?.();
    this.resolveExit(code);
  }

  private stdout(bytes: Uint8Array): void {
    if (this.ended) return;
    if (this.onData) this.onData(bytes);
    else this.early.push(bytes);
  }
}

/** The scratch core as the prototype expects it: one fixture, and a stop that ends the child. */
function scripted(child: FakeConnect): void {
  const core = child.core;
  core.paint = encoder.encode(`\u001b[H\u001b[2Jpaint-${SESSION}\r\n`);
  core.snapshot = { seq: 1, terminals: [FIXTURE] };
  core.answer = (method, params) => {
    if (method === "terminal.run") return { ...FIXTURE, labels: params.labels, state: "live" };
    if (method === "terminal.list") {
      return { terminals: [FIXTURE], hidden_finished: 0, machines: [] };
    }
    if (method === "server.stop") {
      queueMicrotask(() => child.exit(0));
      return { stopped: true };
    }
    return undefined;
  };
}

const status = (seq: number, state: string) => ({
  jsonrpc: "2.0",
  method: "event",
  params: { seq, type: "status", terminal: "t1", data: { status: { state }, reported: true } },
});

/** What the fixture does once the gate opens. */
function openGate(core: FakeCore): void {
  const [events] = core.opened.subscribe;
  const [screen] = core.opened.attach;
  core.output(events as number, lines(status(2, "working")));
  core.output(screen as number, encoder.encode(`live-${SESSION}\r\n`));
  core.output(events as number, lines(status(3, "done")));
}

class FakeRunner implements ProcessRunner {
  readonly spawns: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  readonly children: FakeConnect[] = [];
  /** Sets up each new child; by default, the scripted scratch core. */
  setup: (child: FakeConnect, index: number) => void = (child) => scripted(child);

  spawn(argv: string[], options: { env: Record<string, string>; cwd: string }): OwnedProcess {
    // The spawn contract: nothing from outside the scratch context reaches a child.
    if (options.env.HC_SOCKET !== undefined) throw new Error("HC_SOCKET must not be inherited");
    if (!options.env.HC_SESSION) throw new Error("scratch environment missing HC_SESSION");
    for (const key of ["HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
      if (!options.env[key]?.startsWith(`${ROOT}/`)) {
        throw new Error(`scratch environment missing ${key}`);
      }
    }
    this.spawns.push({ argv, ...options });
    const child = new FakeConnect();
    this.setup(child, this.children.length);
    this.children.push(child);
    return child;
  }

  /** How often each method was called, across every child's core. */
  count(method: string): number {
    return this.children.flatMap((child) => child.core.calls).filter((m) => m === method).length;
  }
}

class FakeRenderer implements Renderer {
  text = "";
  /** Keep `done` callbacks instead of running them. */
  holding = false;
  readonly held: (() => void)[] = [];

  write(bytes: Uint8Array, done: () => void): void {
    this.text += decoder.decode(bytes);
    if (this.holding) this.held.push(done);
    else queueMicrotask(done);
  }

  lines(): string[] {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the paint's escape sequences
    return this.text.split(/\r?\n/).map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
  }

  dispose(): void {}

  release(): void {
    for (const done of this.held.splice(0)) done();
  }
}

/** A prototype run against fakes. The gate plays the fixture unless `onGate` is replaced. */
function harness(env: Env = POISONED) {
  const clock = new FakeClock();
  const fs = new FakeFs();
  const runner = new FakeRunner();
  const renderer = new FakeRenderer();
  const printed: string[] = [];
  const interrupts: ((signal: string) => void)[] = [];
  const h = {
    clock,
    fs,
    runner,
    renderer,
    printed,
    onGate: (core: FakeCore) => openGate(core),
    start: () =>
      track(
        runPrototype({
          runner,
          fs,
          clock,
          renderer: () => renderer,
          print: (line) => printed.push(line),
          env,
          random: () => "test",
          onInterrupt: (listener) => interrupts.push(listener),
        }),
      ),
    interrupt: (signal = "SIGINT") => {
      for (const listener of interrupts) listener(signal);
    },
  };
  fs.onWrite = (path) => {
    const core = runner.children[0]?.core;
    if (path === `${ROOT}/gate` && core) h.onGate(core);
  };
  return h;
}

describe("scratch isolation", () => {
  test("every spawn gets the scratch environment and nothing else from the parent", async () => {
    const h = harness();
    const run = h.start();
    await settle();
    expect(run.value?.errors).toEqual([]);
    expect(run.value?.ok).toBe(true);
    expect(h.runner.spawns).toEqual([
      { argv: ["hc", "connect"], env: SCRATCH_ENV, cwd: `${ROOT}/cwd` },
    ]);
  });

  test("names each way a child could leave the scratch context", () => {
    const context = createScratchContext(new FakeFs(), () => "test");
    const env = scratchEnv(context, POISONED);
    expect(isolationProblem(context, env)).toBeUndefined();
    const { XDG_RUNTIME_DIR: _, ...noRuntime } = env;
    expect(isolationProblem(context, noRuntime)).toBe(
      "scratch environment missing XDG_RUNTIME_DIR",
    );
    expect(isolationProblem(context, { ...env, HC_SOCKET: "/x.sock" })).toBe(
      "HC_SOCKET must not be inherited",
    );
    expect(isolationProblem(context, { ...env, HC_TERMINAL_ID: "t9" })).toBe(
      "HC_TERMINAL_ID must not be inherited",
    );
    expect(isolationProblem(context, { ...env, HC_SESSION: "default" })).toBe(
      "scratch environment missing HC_SESSION",
    );
    expect(
      isolationProblem(context, { ...env, XDG_STATE_HOME: "/Users/someone/.local/state" }),
    ).toBe("XDG_STATE_HOME is outside the scratch root");
    expect(isolationProblem(context, { ...env, API_TOKEN: "secret" })).toBe(
      "scratch environment carries API_TOKEN",
    );
  });

  test("an incomplete context spawns nothing: SCRATCH_ISOLATION_REQUIRED", () => {
    const runner = new FakeRunner();
    const partial = { root: ROOT, session: SESSION, home: `${ROOT}/home` } as ScratchContext;
    for (const context of [partial, undefined]) {
      const env = context ? { ...SCRATCH_ENV } : {};
      expect(() => spawnScratchConnect(context, env, runner, "workflow")).toThrow(
        "SCRATCH_ISOLATION_REQUIRED",
      );
    }
    expect(runner.spawns).toEqual([]);
  });

  test("the cleanup connection is scratch-only too", async () => {
    const h = harness();
    h.runner.setup = (child, index) => {
      scripted(child);
      if (index === 0) child.core.hold("hello");
    };
    const run = h.start();
    await h.clock.advance(STAGE_MS);
    expect(run.value?.errors).toEqual(["prototype deadline exceeded: connect"]);
    expect(h.runner.spawns.map((spawn) => spawn.env)).toEqual([SCRATCH_ENV, SCRATCH_ENV]);
  });
});

describe("deadlines", () => {
  test("a connect that never answers fails at its deadline, then cleanup runs once", async () => {
    const h = harness();
    h.runner.setup = (child, index) => {
      scripted(child);
      if (index === 0) child.core.hold("hello");
    };
    const run = h.start();
    await h.clock.advance(STAGE_MS - 1);
    expect([run.settled, h.runner.count("server.stop")]).toEqual([false, 0]);
    await h.clock.advance(1);
    expect(run.value).toEqual({
      ok: false,
      errors: ["prototype deadline exceeded: connect"],
      cleaned: true,
    });
    expect(h.runner.count("server.stop")).toBe(1);
    expect(h.fs.removed).toEqual([ROOT]);
  });

  test("a renderer that never finishes fails at the render deadline", async () => {
    const h = harness();
    h.renderer.holding = true;
    const run = h.start();
    await h.clock.advance(STAGE_MS - 1);
    expect(run.settled).toBe(false);
    await h.clock.advance(1);
    expect(run.value?.errors).toEqual(["prototype deadline exceeded: render"]);
    expect([run.value?.cleaned, h.runner.count("server.stop")]).toEqual([true, 1]);
  });

  test("a live marker that never shows fails at the marker deadline, saying what is missing", async () => {
    const h = harness();
    h.onGate = () => {};
    const run = h.start();
    await h.clock.advance(STAGE_MS - 1);
    expect(run.settled).toBe(false);
    await h.clock.advance(1);
    expect(run.value?.errors).toEqual([
      "prototype screen missing live-output marker",
      "prototype status working never arrived",
      "prototype status done never arrived",
      "prototype deadline exceeded: marker",
    ]);
    expect(run.value?.cleaned).toBe(true);
  });

  test("the stages share one thirty-second limit", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      child.core.hold("hello");
      child.core.hold("terminal.run");
    };
    h.renderer.holding = true;
    h.onGate = () => {};
    const run = h.start();
    const core = () => (h.runner.children[0] as FakeConnect).core;
    await h.clock.advance(9_000);
    core().release("hello");
    await h.clock.advance(9_000);
    core().release("terminal.run");
    await h.clock.advance(9_000);
    h.renderer.holding = false;
    h.renderer.release();
    await h.clock.advance(2_999);
    expect(run.settled).toBe(false);
    await h.clock.advance(1);
    expect(run.value?.errors.at(-1)).toBe("prototype deadline exceeded: workflow");
  });
});

describe("cleanup", () => {
  test("a server.stop that never answers ends cleanup at its deadline and keeps the scratch state", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      child.core.hold("server.stop");
    };
    const run = h.start();
    await h.clock.advance(CLEANUP_MS - 1);
    expect(run.settled).toBe(false);
    await h.clock.advance(1);
    expect(run.value).toEqual({
      ok: false,
      errors: [
        "prototype deadline exceeded: cleanup",
        "scratch shutdown was not acknowledged",
        "scratch shutdown unconfirmed; retained scratch state",
      ],
      cleaned: false,
    });
    expect(h.fs.removed).toEqual([]);
    expect(h.printed).toContain(`cleanup: kept ${ROOT}`);
  });

  test("an interruption during startup still gets one scoped shutdown, under a fresh token", async () => {
    const h = harness();
    h.runner.setup = (child, index) => {
      scripted(child);
      if (index === 0) child.core.hold("hello");
    };
    const run = h.start();
    await settle();
    h.interrupt("SIGINT");
    await settle();
    expect(run.value?.errors).toEqual(["prototype cancelled: SIGINT"]);
    expect(h.runner.count("server.stop")).toBe(1);
    expect(run.value?.cleaned).toBe(true);
  });

  test("repeated interruption during shutdown doesn't move cleanup's deadline", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      child.core.hold("server.stop");
    };
    const run = h.start();
    await h.clock.advance(5_000);
    h.interrupt("SIGINT");
    await h.clock.advance(4_000);
    h.interrupt("SIGTERM");
    await h.clock.advance(999);
    expect(run.settled).toBe(false);
    await h.clock.advance(1);
    expect(run.value?.cleaned).toBe(false);
    expect(run.value?.errors).toContain("scratch shutdown unconfirmed; retained scratch state");
    expect(h.printed).toContain("SIGTERM: cleanup is running and ends by its own deadline");
    expect(h.runner.count("server.stop")).toBe(1);
  });

  test("a renderer callback after the run is over sends no credit and prints nothing", async () => {
    const h = harness();
    h.renderer.holding = true;
    h.runner.setup = (child) => {
      scripted(child);
      child.core.hold("server.stop");
    };
    const run = h.start();
    await h.clock.advance(STAGE_MS);
    const core = (h.runner.children[0] as FakeConnect).core;
    const [screen] = core.opened.attach;
    const printed = h.printed.length;
    h.renderer.release();
    await settle();
    expect(core.credits(screen as number)).toEqual([]);
    expect(h.printed).toHaveLength(printed);
    core.release("server.stop");
    await settle();
    expect(run.value?.errors).toEqual(["prototype deadline exceeded: render"]);
    expect(run.value?.cleaned).toBe(true);
  });

  test("a hello the core refuses still gets the core stopped, over the same plain connection", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      child.core.helloError = {
        code: -32000,
        message: "unsupported_generation",
        data: { kind: "unsupported_generation" },
      };
    };
    const run = h.start();
    await settle();
    expect(run.value).toEqual({
      ok: false,
      errors: ["unsupported_generation (unsupported_generation)"],
      cleaned: true,
    });
    expect(h.runner.spawns).toHaveLength(1);
    expect(h.runner.count("server.stop")).toBe(1);
  });

  test("an owned child that exits after the cancellation still lets cleanup finish", async () => {
    const h = harness();
    h.runner.setup = (child, index) => {
      scripted(child);
      if (index === 0) {
        child.core.hold("hello");
        child.exitOnClose = false;
      }
    };
    const run = h.start();
    await settle();
    h.interrupt("SIGTERM");
    await h.clock.advance(3_000);
    expect(run.settled).toBe(false);
    (h.runner.children[0] as FakeConnect).exit(0);
    await settle();
    expect(run.value).toEqual({
      ok: false,
      errors: ["prototype cancelled: SIGTERM"],
      cleaned: true,
    });
    expect((h.runner.children[0] as FakeConnect).killed).toBe(false);
  });

  test("refuses server.stop on a core that runs terminals this run didn't start", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      const answer = child.core.answer;
      child.core.answer = (method, params) =>
        method === "terminal.list"
          ? {
              terminals: [FIXTURE, { address: "t2", labels: {} }],
              hidden_finished: 0,
              machines: [],
            }
          : answer(method, params);
    };
    const run = h.start();
    await h.clock.advance(CLEANUP_MS);
    expect(h.runner.count("server.stop")).toBe(0);
    expect(run.value?.errors).toEqual([
      "refusing server.stop: the core runs 1 terminal(s) this run didn't start",
      "scratch shutdown was not acknowledged",
      "scratch shutdown unconfirmed; retained scratch state",
    ]);
    expect(h.fs.removed).toEqual([]);
  });
});

describe("the checked run", () => {
  test("prints the snapshot and both statuses before the confirmed shutdown, and removes the scratch root", async () => {
    const h = harness();
    const run = h.start();
    await settle();
    expect(run.value).toEqual({ ok: true, errors: [], cleaned: true });
    const at = (prefix: string) => h.printed.findIndex((line) => line.startsWith(prefix));
    expect(h.printed[at("subscribe:")]).toBe(
      `subscribe: {"terminal":"t1","labels":{"${RUN_LABEL}":"${SESSION}"}}`,
    );
    const order = [
      at("hello: hc 0.1.16"),
      at("snapshot: seq 1, t1"),
      at("attach: t1 on channel 2, observe only"),
      at("status: working"),
      at("status: done"),
      at(`screen: paint-${SESSION}`),
      at(`screen: live-${SESSION}`),
      at("cleanup: server.stop acknowledged"),
      at(`cleanup: scratch shutdown confirmed; removed ${ROOT}`),
      at("prototype ok"),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.fs.removed).toEqual([ROOT]);
    expect(h.fs.written).toEqual([`${ROOT}/gate`]);
  });

  test("attaches observe-only, writes no keys or RESIZE, and credits what it rendered", async () => {
    const h = harness();
    const run = h.start();
    await settle();
    expect(run.value?.ok).toBe(true);
    const core = (h.runner.children[0] as FakeConnect).core;
    const [screen] = core.opened.attach;
    const attach = core
      .frames(0, FrameKind.Data)
      .map((f) => JSON.parse(decoder.decode(f.payload)))
      .find((request) => request.method === "terminal.attach");
    expect(attach.params).toEqual({ terminal: "t1", cols: 80, rows: 24, observe: true });
    expect(core.frames(screen as number, FrameKind.Data)).toEqual([]);
    expect(core.frames(screen as number, FrameKind.Resize)).toEqual([]);
    const credited = core.credits(screen as number).reduce((sum, n) => sum + n, 0);
    expect(credited).toBe(core.paint.length + encoder.encode(`live-${SESSION}\r\n`).length);
  });

  test("a snapshot without the fixture fails the run", async () => {
    const h = harness();
    h.runner.setup = (child) => {
      scripted(child);
      child.core.snapshot = { seq: 1, terminals: [] };
    };
    const run = h.start();
    await settle();
    expect(run.value?.errors).toEqual(["prototype subscription snapshot missing"]);
    expect(run.value?.cleaned).toBe(true);
  });
});
