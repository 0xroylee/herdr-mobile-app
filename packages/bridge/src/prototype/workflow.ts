// One checked end-to-end run against a scratch herdr-core. It starts `hc connect` in a scratch
// session, says hello in framed mode, runs a fixture, subscribes to its events, attaches to it as
// an observer, renders what arrives, and checks each step. Every stage has ten seconds inside a
// thirty-second run. Then cleanup runs once, with a fresh token and its own ten seconds: it stops
// the scratch core over RPC, waits for its own `hc connect` children, and only then removes the
// scratch directories. When it can't confirm the shutdown it says so and keeps them.

import {
  type AttachHandle,
  createClient,
  type EventSnapshot,
  type HcClient,
  HcRpcError,
} from "@herdr-mobile/hc-client";
import type { HcEvent } from "@herdr-mobile/protocol";
import { type Clock, DeadlineError, within } from "./deadline.ts";
import type { OwnedProcess, ProcessRunner } from "./process.ts";
import type { Renderer } from "./renderer.ts";
import {
  createScratchContext,
  type Env,
  type ScratchContext,
  type ScratchFs,
  scratchEnv,
  spawnScratchConnect,
} from "./scratch.ts";

export const STAGE_MS = 10_000;
export const WORKFLOW_MS = 30_000;
export const CLEANUP_MS = 10_000;
/** The hc version the schema in packages/protocol is pinned to. */
export const PINNED_VERSION = "0.1.17";
/** Marks the fixture as this run's. */
export const RUN_LABEL = "herdr-mobile.prototype";
const COLS = 80;
const ROWS = 24;

/**
 * Prints its first-paint marker, waits for the gate, then reports `working` through OSC 7501,
 * prints its live marker and reports `done`. It stays alive until the core stops.
 */
export const FIXTURE = [
  `printf 'paint-%s\\r\\n' "$MARK"`,
  `while [ ! -e "$GATE" ]; do sleep 0.05; done`,
  `printf '\\033]7501;state=working\\033\\\\'`,
  `printf 'live-%s\\r\\n' "$MARK"`,
  `printf '\\033]7501;state=done\\033\\\\'`,
  "exec sleep 600",
].join("\n");

export interface PrototypeDeps {
  runner: ProcessRunner;
  fs: ScratchFs;
  clock: Clock;
  renderer: (cols: number, rows: number) => Renderer;
  /** Gets each report line, in order. */
  print: (line: string) => void;
  /** The caller's environment. Children only ever get PATH and the locale from it. */
  env: Env;
  /** The scratch session's random suffix. */
  random: () => string;
  /** Registers the listener for SIGINT and SIGTERM, called once per signal. */
  onInterrupt: (listener: (signal: string) => void) => void;
}

export interface PrototypeResult {
  ok: boolean;
  /** What went wrong, in order. */
  errors: string[];
  /** The scratch core's shutdown was confirmed and its directories removed. */
  cleaned: boolean;
}

interface Connection {
  client: HcClient;
  process: OwnedProcess;
}

interface Stage {
  name: string;
  end: number;
}

export function runPrototype(deps: PrototypeDeps): Promise<PrototypeResult> {
  return new PrototypeRun(deps).run();
}

function explain(error: unknown): string {
  if (error instanceof HcRpcError)
    return error.kind ? `${error.message} (${error.kind})` : error.message;
  return error instanceof Error ? error.message : String(error);
}

class PrototypeRun {
  private readonly deps: PrototypeDeps;
  /** Aborted by the first interruption: every workflow wait then rejects. */
  private readonly workflowAbort = new AbortController();
  private readonly errors: string[] = [];
  /** Every `hc connect` this run started, registered as soon as it is spawned. */
  private readonly owned: OwnedProcess[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly statuses: string[] = [];
  private context: ScratchContext | undefined;
  private main: Connection | undefined;
  private renderer: Renderer | undefined;
  private attachment: AttachHandle | undefined;
  private snapshot: EventSnapshot | undefined;
  /** Writes not on the screen yet. */
  private rendering = 0;
  /** Bytes rendered before the attach handle existed: the first paint can come first. */
  private owed = 0;
  /** The workflow is over: late renderer and event callbacks do nothing. */
  private finished = false;
  private workflowEnd = 0;
  private cleanup: Promise<boolean> | undefined;
  private cleanupTimer: unknown;

  constructor(deps: PrototypeDeps) {
    this.deps = deps;
    deps.onInterrupt((signal) => this.interrupt(signal));
  }

  async run(): Promise<PrototypeResult> {
    this.workflowEnd = this.deps.clock.now() + WORKFLOW_MS;
    try {
      await this.workflow();
    } catch (error) {
      this.fail(error);
    }
    this.finished = true;
    this.waiters.clear();
    const cleaned = await this.cleanUp();
    this.renderer?.dispose();
    const ok = this.errors.length === 0 && cleaned;
    this.deps.print(ok ? "prototype ok" : `prototype failed: ${this.errors.join("; ")}`);
    return { ok, errors: [...this.errors], cleaned };
  }

  private interrupt(signal: string): void {
    if (this.cleanup) {
      this.deps.print(`${signal}: cleanup is running and ends by its own deadline`);
      return;
    }
    this.deps.print(`${signal}: stopping the run, then cleaning up`);
    this.workflowAbort.abort(signal);
  }

  private async workflow(): Promise<void> {
    const { deps } = this;
    const context = createScratchContext(deps.fs, deps.random);
    this.context = context;
    deps.print(`scratch: session ${context.session} in ${context.root}`);

    let stage = this.stage("connect");
    const main = this.open(context, scratchEnv(context, deps.env), "workflow");
    this.main = main;
    const hello = await this.wait(stage, main.client.hello({ framed: true }));
    if (hello.version !== PINNED_VERSION) {
      throw new Error(`prototype expects hc ${PINNED_VERSION}, got ${hello.version}`);
    }
    deps.print(`hello: hc ${hello.version}, protocol generation ${hello.generation}, framed`);

    stage = this.stage("setup");
    const fixture = await this.wait(
      stage,
      main.client.call("terminal.run", {
        argv: ["/bin/sh", "-c", FIXTURE],
        cwd: context.cwd,
        env: { GATE: context.gate, MARK: context.session },
        labels: { [RUN_LABEL]: context.session },
        no_parent: true,
        wait: false,
        keep: false,
      }),
    );
    deps.print(`fixture: ${fixture.address}`);
    const filter = { terminal: fixture.address, labels: { [RUN_LABEL]: context.session } };
    await this.wait(
      stage,
      main.client.subscribeEvents(filter, {
        onSnapshot: (snapshot) => {
          if (!this.finished) this.snapshot = snapshot;
        },
        onEvent: (event) => this.onEvent(event),
      }),
    );
    const snapshot = this.snapshot;
    if (snapshot?.terminals.length !== 1 || snapshot.terminals[0]?.address !== fixture.address) {
      throw new Error("prototype subscription snapshot missing");
    }
    deps.print(`subscribe: ${JSON.stringify(filter)}`);
    deps.print(`snapshot: seq ${snapshot.seq}, ${fixture.address}`);
    this.renderer = deps.renderer(COLS, ROWS);
    const attachment = await this.wait(
      stage,
      main.client.attach(
        { terminal: fixture.address, cols: COLS, rows: ROWS, observe: true },
        { onData: (bytes) => this.render(bytes) },
      ),
    );
    this.attachment = attachment;
    if (!attachment.observe) throw new Error("terminal.attach must use observe:true");
    this.consume(0);
    deps.print(`attach: ${fixture.address} on channel ${attachment.channel}, observe only`);

    stage = this.stage("render");
    const paint = `paint-${context.session}`;
    await this.wait(
      stage,
      this.until(() => this.rendering === 0 && this.screen().includes(paint)),
    );
    deps.print("render: first paint on screen");

    deps.fs.writeFile(context.gate, "");
    stage = this.stage("marker");
    const live = `live-${context.session}`;
    const seen = () =>
      this.rendering === 0 &&
      this.screen().includes(live) &&
      this.statuses.includes("working") &&
      this.statuses.includes("done");
    try {
      await this.wait(stage, this.until(seen));
    } catch (error) {
      if (!this.screen().includes(live))
        this.errors.push("prototype screen missing live-output marker");
      for (const word of ["working", "done"]) {
        if (!this.statuses.includes(word))
          this.errors.push(`prototype status ${word} never arrived`);
      }
      throw error;
    }
    for (const word of this.statuses) deps.print(`status: ${word}`);
    for (const row of this.renderer.lines()) {
      if (row !== "") deps.print(`screen: ${row}`);
    }
  }

  /** Starts a checked `hc connect` and wires a client to it. */
  private open(context: ScratchContext, env: Env, purpose: "workflow" | "cleanup"): Connection {
    const child = spawnScratchConnect(context, env, this.deps.runner, purpose);
    this.owned.push(child);
    const client = createClient({
      write: (bytes) => child.write(bytes),
      requestTransportClose: () => child.closeInput(),
    });
    child.read(
      (bytes) => {
        try {
          client.feed(bytes);
        } catch (error) {
          this.fail(error);
        }
      },
      () => client.end(),
    );
    return { client, process: child };
  }

  private render(bytes: Uint8Array): void {
    const renderer = this.renderer;
    if (this.finished || !renderer) return;
    this.rendering++;
    renderer.write(bytes, () => {
      // A callback after the run is over sends no credit and reports nothing.
      if (this.finished) return;
      this.rendering--;
      this.consume(bytes.length);
      this.changed();
    });
  }

  /** Returns rendered bytes as credit, or keeps them until the attach handle exists. */
  private consume(count: number): void {
    this.owed += count;
    if (!this.attachment || this.owed === 0) return;
    this.attachment.consume(this.owed);
    this.owed = 0;
  }

  private onEvent(event: HcEvent): void {
    if (this.finished || event.type !== "status") return;
    const data = event.data as { status?: { state?: string } | null } | null;
    this.statuses.push(data?.status?.state ?? "cleared");
    this.changed();
  }

  private screen(): string {
    return this.renderer?.lines().join("\n") ?? "";
  }

  private stage(name: string): Stage {
    return { name, end: this.deps.clock.now() + STAGE_MS };
  }

  /** Waits for `work` within the stage's ten seconds and what is left of the run's thirty. */
  private wait<T>(stage: Stage, work: Promise<T>): Promise<T> {
    const workflowFirst = this.workflowEnd < stage.end;
    const end = workflowFirst ? this.workflowEnd : stage.end;
    return within(
      workflowFirst ? "workflow" : stage.name,
      work,
      end - this.deps.clock.now(),
      this.deps.clock,
      this.workflowAbort.signal,
    );
  }

  private until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!done()) return;
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  private changed(): void {
    for (const check of [...this.waiters]) check();
  }

  private fail(error: unknown): void {
    this.errors.push(explain(error));
  }

  private cleanUp(): Promise<boolean> {
    this.cleanup ??= this.runCleanup();
    return this.cleanup;
  }

  private async runCleanup(): Promise<boolean> {
    const { clock } = this.deps;
    // A fresh token, so an interrupted workflow still gets its cleanup; one deadline for all of it.
    const abort = new AbortController();
    this.cleanupTimer = clock.setTimeout(
      () => abort.abort(new DeadlineError("cleanup")),
      CLEANUP_MS,
    );
    try {
      return await this.shutDown(abort.signal);
    } finally {
      clock.clearTimeout(this.cleanupTimer);
    }
  }

  private async shutDown(signal: AbortSignal): Promise<boolean> {
    const context = this.context;
    if (!context) return true;
    const step = <T>(work: Promise<T>) =>
      within("cleanup", work, undefined, this.deps.clock, signal);
    // A core only starts when an `hc connect` runs: with none, there is nothing to stop.
    let acknowledged = this.owned.length === 0;
    if (!acknowledged) {
      try {
        acknowledged = await this.stopCore(context, step);
      } catch (error) {
        this.fail(error);
      }
    }
    if (!acknowledged) this.errors.push("scratch shutdown was not acknowledged");
    const exited = await this.closeOwned(step, signal);
    if (!acknowledged || !exited) {
      this.errors.push("scratch shutdown unconfirmed; retained scratch state");
      this.deps.print(`cleanup: kept ${context.root}`);
      return false;
    }
    this.deps.fs.remove(context.root);
    this.deps.print(`cleanup: scratch shutdown confirmed; removed ${context.root}`);
    return true;
  }

  /**
   * Stops the scratch core over the workflow's connection while it still takes calls, or else
   * over one more scratch-only connection. That one stays plain: plain calls need no hello.
   */
  private async stopCore(
    context: ScratchContext,
    step: <T>(work: Promise<T>) => Promise<T>,
  ): Promise<boolean> {
    let client = this.main?.client;
    if (!client?.acceptsCalls) {
      client = this.open(context, scratchEnv(context, this.deps.env), "cleanup").client;
    }
    // Never stop a core that runs anything this run didn't start.
    const list = await step(client.call("terminal.list", { all: true }));
    const strangers = list.terminals.filter((t) => t.labels?.[RUN_LABEL] !== context.session);
    if (strangers.length > 0) {
      throw new Error(
        `refusing server.stop: the core runs ${strangers.length} terminal(s) this run didn't start`,
      );
    }
    const stop = await step(client.call("server.stop", {}));
    this.deps.print(`cleanup: server.stop ${stop.stopped ? "acknowledged" : "refused"}`);
    return stop.stopped === true;
  }

  /**
   * Closes every owned `hc connect` and waits for them to exit, while cleanup has time left.
   * Then kills the ones that haven't.
   */
  private async closeOwned(
    step: <T>(work: Promise<T>) => Promise<T>,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const child of this.owned) child.closeInput();
    if (!signal.aborted) {
      try {
        await step(Promise.all(this.owned.map((child) => child.exited)));
        return true;
      } catch (error) {
        this.fail(error);
      }
    }
    for (const child of this.owned) child.kill();
    return false;
  }
}
