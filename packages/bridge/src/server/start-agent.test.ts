import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type { DeviceRecordView, StartAgentRequest } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { ROOT_RESOLVE_TIMEOUT_MS } from "./roots.ts";
import { AgentStarter, type CoreCaller, type StatFs } from "./start-agent.ts";

class ManualClock implements Clock {
  private current = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  pending(): number[] {
    return [...this.timers.values()]
      .map(({ at }) => at - this.current)
      .sort((left, right) => left - right);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      timer.callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

class FakeChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  killed = false;
  private readonly stdoutText: string;
  private readonly stderrText: string;

  constructor(stdoutText = "", stderrText = "", exitCode: number | null = 0) {
    this.stdoutText = stdoutText;
    this.stderrText = stderrText;
    this.exited = Promise.resolve(exitCode);
  }
  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdoutText) onData(new TextEncoder().encode(this.stdoutText));
    onEnd();
  }
  readStderr(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stderrText) onData(new TextEncoder().encode(this.stderrText));
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class HangingChild implements OwnedProcess {
  readonly exited = new Promise<number | null>(() => {});
  killed = false;
  write(): void {}
  closeInput(): void {}
  read(): void {}
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  readonly children: OwnedProcess[] = [];
  lsExitCode = 1;
  doOutput = "";
  doError = "";
  doExitCode = 0;
  hangDo = false;

  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    const child =
      argv[1] === "ls"
        ? new FakeChild("{}", "", this.lsExitCode)
        : this.hangDo
          ? new HangingChild()
          : new FakeChild(this.doOutput, this.doError, this.doExitCode);
    this.children.push(child);
    return child;
  }
}

class MapFs {
  readonly directories = new Set([
    "/home/owner",
    "/home/owner/project",
    "/workspace",
    "/workspace/project",
  ]);
  readonly canonicalPaths = new Map<string, string>();
  readonly stats: string[] = [];

  async realPath(path: string): Promise<string> {
    const canonical = this.canonicalPaths.get(path) ?? path;
    if (!this.directories.has(canonical)) throw new Error("ENOENT");
    return canonical;
  }

  async stat(path: string): Promise<{ isDirectory(): boolean }> {
    this.stats.push(path);
    if (!this.directories.has(path)) throw new Error("ENOENT");
    return { isDirectory: () => true };
  }
}

const control: DeviceRecordView = {
  id: "device-9",
  name: "Phone",
  role: "control",
  createdAt: 1,
  lastSeenAt: null,
};
const watch: DeviceRecordView = { ...control, id: "device-watch", role: "watch" };

function request(updates: Partial<StartAgentRequest> = {}): StartAgentRequest {
  return {
    run: { kind: "program", id: "claude" },
    folder: "/home/owner/project",
    space: { kind: "existing", id: "sp-existing" },
    ...updates,
  };
}

function setup(
  options: {
    coreCall?: CoreCaller;
    clock?: Clock;
    statFs?: StatFs;
    roots?: string[];
    home?: string;
    output?: (line: string) => void;
  } = {},
) {
  const runner = new FakeRunner();
  const calls: { method: string; params: unknown }[] = [];
  const statFs = options.statFs ?? new MapFs();
  const coreCall: CoreCaller =
    options.coreCall ??
    (async (method, params) => {
      calls.push({ method, params });
      if (method === "templates.list")
        return { templates: [{ name: "review", description: "Review" }] };
      return { address: "t27", argv: ["claude"], cwd: "/home/owner/project" };
    });
  const starter = new AgentStarter({
    runner,
    statFs,
    coreCall,
    clock: options.clock,
    programs: ["claude", "codex", "aider"],
    roots: options.roots ?? ["/home/owner", "/workspace"],
    home: options.home ?? "/home/owner",
    herdrAppPath: "/opt/herdr-app",
    hcPath: "/opt/hc",
    env: { HOME: "/home/owner", PATH: "/usr/bin" },
    cwd: "/repo",
    output: options.output,
    idGenerator(prefix) {
      return prefix === "sp" ? "sp-new" : "tb-new";
    },
  });
  return { starter, runner, calls, statFs };
}

function parseAuditLine(line: string | undefined): Record<string, unknown> {
  const prefix = "Agent started ";
  if (!line?.startsWith(prefix)) throw new Error("missing agent start audit line");
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("AgentStarter", () => {
  test("rejects a watch caller before starting any process", async () => {
    const { starter, runner, calls } = setup();
    await expect(starter.start(request(), watch)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects an unknown program and an unknown template before probing the window", async () => {
    const { starter, runner } = setup();
    await expect(
      starter.start(request({ run: { kind: "program", id: "bash" } }), control),
    ).rejects.toMatchObject({ status: 422, code: "run_not_allowed" });
    await expect(
      starter.start(request({ run: { kind: "template", name: "missing" } }), control),
    ).rejects.toMatchObject({ status: 422, code: "run_not_allowed" });
    expect(runner.argv).toEqual([]);
  });

  test("resolves ~/ folders and starts a closed-window built-in without a task", async () => {
    const { starter, runner, calls } = setup();
    const reply = await starter.start(
      request({ folder: "~/project", run: { kind: "program", id: "claude" } }),
      control,
    );

    expect(reply).toEqual({
      placement: "core",
      address: "t27",
      space: { id: "sp-existing", isNew: false },
      tab: { id: "tb-new", isNew: true },
    });
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(calls).toEqual([
      {
        method: "terminal.run",
        params: {
          argv: ["claude"],
          cwd: "/home/owner/project",
          labels: {
            "herdr.space": "sp-existing",
            "herdr.tab": "tb-new",
            "herdr-mobile.origin": "device-9",
          },
          keep: true,
          no_parent: true,
          wait: false,
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"line"');
  });

  for (const task of [
    "--dangerously-skip-permissions",
    "-p",
    "update",
    "login",
    "Inspect the change",
  ]) {
    test(`keeps a built-in first message out of argv when Herdr is open: ${task}`, async () => {
      const { starter, runner, calls } = setup();
      runner.lsExitCode = 0;
      runner.doOutput = '{"address":"t41","space_id":"sp-existing","tab_id":"tb41"}';

      await starter.start(request({ run: { kind: "program", id: "codex" }, task }), control);

      const args = JSON.parse(runner.argv[1]?.[3] ?? "{}") as Record<string, unknown>;
      expect(args.argv).toEqual(["codex"]);
      expect(args.task).toBe(task);
      expect(calls).toEqual([]);
    });

    test(`refuses a built-in first message when Herdr is closed: ${task}`, async () => {
      const { starter, runner, calls } = setup();

      await expect(
        starter.start(request({ run: { kind: "program", id: "claude" }, task }), control),
      ).rejects.toMatchObject({
        status: 422,
        code: "run_not_allowed",
        message:
          "First messages for claude need Herdr open on your Mac. Open Herdr, or leave the message empty.",
      });

      expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
      expect(calls).toEqual([]);
    });
  }

  test("creates stable-shape ids for a new core space and tab", async () => {
    const { starter, calls } = setup();
    const reply = await starter.start(request({ space: { kind: "new", name: "Review" } }), control);

    expect(reply.space).toEqual({ id: "sp-new", isNew: true });
    expect(reply.tab).toEqual({ id: "tb-new", isNew: true });
    expect(calls[0]?.params).toMatchObject({
      labels: { "herdr.space": "sp-new", "herdr.tab": "tb-new" },
    });
  });

  test("uses herdr-app do JSON-object arguments for argv arrays and preserves task separately", async () => {
    const { starter, runner, calls } = setup();
    runner.lsExitCode = 0;
    runner.doOutput = '{"address":"t41","space":{"id":"sp-existing"},"tab":{"id":"tb41"}}\n';

    const reply = await starter.start(
      request({ run: { kind: "program", id: "claude" }, task: "Review the files" }),
      control,
    );

    expect(reply).toEqual({
      placement: "window",
      address: "t41",
      space: { id: "sp-existing", isNew: false },
      tab: { id: "tb41", isNew: true },
    });
    expect(runner.argv).toHaveLength(2);
    expect(runner.argv[1]?.slice(0, 3)).toEqual(["/opt/herdr-app", "do", "tab.new"]);
    expect(runner.argv[1]?.slice(3)).toEqual([
      JSON.stringify({
        folder: "/home/owner/project",
        argv: ["claude"],
        task: "Review the files",
        space: "sp-existing",
      }),
    ]);
    expect(calls).toEqual([]);
  });

  for (const task of ["--dangerously-skip-permissions", "-p", "update", "login", "Review this"]) {
    test(`keeps a template first message in herdr-core argv: ${task}`, async () => {
      const { starter, calls } = setup();
      await starter.start(request({ run: { kind: "template", name: "review" }, task }), control);

      expect(calls[1]).toMatchObject({
        method: "terminal.run",
        params: { argv: ["review", task] },
      });
    });

    test(`keeps a template first message separate from argv when Herdr is open: ${task}`, async () => {
      const { starter, runner, calls } = setup();
      runner.lsExitCode = 0;
      runner.doOutput = '{"address":"t41","space_id":"sp-existing","tab_id":"tb41"}';

      await starter.start(request({ run: { kind: "template", name: "review" }, task }), control);

      const args = JSON.parse(runner.argv[1]?.[3] ?? "{}") as Record<string, unknown>;
      expect(args.argv).toEqual(["review"]);
      expect(args.task).toBe(task);
      expect(calls).toEqual([{ method: "templates.list", params: {} }]);
    });
  }

  test("accepts successful herdr-app output that has no address or location ids", async () => {
    const { starter, runner } = setup();
    runner.lsExitCode = 0;
    runner.doOutput = "Started.\n";

    const reply = await starter.start(request(), control);

    expect(reply).toEqual({
      placement: "window",
      space: { id: "sp-existing", isNew: false },
      tab: { id: "", isNew: true },
    });
  });

  test("uses a template only after a fresh templates.list result", async () => {
    const { starter, runner, calls } = setup();
    await starter.start(
      request({ run: { kind: "template", name: "review" }, task: "Review this" }),
      control,
    );

    expect(calls).toEqual([
      { method: "templates.list", params: {} },
      {
        method: "terminal.run",
        params: {
          argv: ["review", "Review this"],
          cwd: "/home/owner/project",
          labels: {
            "herdr.space": "sp-existing",
            "herdr.tab": "tb-new",
            "herdr-mobile.origin": "device-9",
          },
          keep: true,
          no_parent: true,
          wait: false,
        },
      },
    ]);
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
  });

  test("rejects an outside or missing folder without spawning a process", async () => {
    const statFs = new MapFs();
    statFs.directories.add("/etc");
    const { starter, runner } = setup({ statFs });
    await expect(starter.start(request({ folder: "/etc" }), control)).rejects.toMatchObject({
      status: 422,
      code: "folder_not_allowed",
    });
    await expect(
      starter.start(request({ folder: "/home/owner/missing" }), control),
    ).rejects.toMatchObject({ status: 422, code: "folder_missing" });
    expect(runner.argv).toEqual([]);
  });

  test("rejects a final-component symlink whose target escapes the allowed roots", async () => {
    const statFs = new MapFs();
    statFs.directories.add("/outside/project");
    statFs.canonicalPaths.set("/home/owner/outside-link", "/outside/project");
    statFs.canonicalPaths.set("/home/owner/outside-link/project", "/outside/project");
    const { starter, runner, calls } = setup({ statFs });

    await expect(
      starter.start(request({ folder: "/home/owner/outside-link" }), control),
    ).rejects.toMatchObject({ status: 422, code: "folder_not_allowed" });

    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
    expect(statFs.stats).toEqual([]);
  });

  test("rejects a symlinked parent whose target escapes the allowed roots", async () => {
    const statFs = new MapFs();
    statFs.directories.add("/outside/project");
    statFs.canonicalPaths.set("/home/owner/linked-parent/project", "/outside/project");
    const { starter, runner, calls } = setup({ statFs });

    await expect(
      starter.start(request({ folder: "/home/owner/linked-parent/project" }), control),
    ).rejects.toMatchObject({ status: 422, code: "folder_not_allowed" });

    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
    expect(statFs.stats).toEqual([]);
  });

  test("accepts a folder under an allowed symlinked root and passes its canonical path", async () => {
    const statFs = new MapFs();
    statFs.canonicalPaths.set("/linked/workspace", "/workspace");
    statFs.canonicalPaths.set("/linked/workspace/project", "/workspace/project");
    const { starter, calls, runner } = setup({ statFs, roots: ["/linked/workspace"] });

    await starter.start(request({ folder: "/linked/workspace/project" }), control);

    expect(calls[0]).toMatchObject({
      method: "terminal.run",
      params: { cwd: "/workspace/project" },
    });
    expect(statFs.stats).toEqual(["/workspace/project"]);
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
  });

  test("starts from an allowed home folder when an additional root is missing", async () => {
    const { starter, runner, calls } = setup({ roots: ["/home/owner", "/offline"] });

    await expect(starter.start(request(), control)).resolves.toMatchObject({ placement: "core" });

    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(calls[0]).toMatchObject({
      method: "terminal.run",
      params: { cwd: "/home/owner/project" },
    });
  });

  test("starts from an allowed folder before a never-settling additional root reaches the deadline", async () => {
    const clock = new ManualClock();
    const never = new Promise<string>(() => {});
    const statFs: StatFs = {
      async realPath(path) {
        if (path === "/offline") return await never;
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const { starter, runner, calls } = setup({
      clock,
      roots: ["/home/owner", "/offline"],
      statFs,
    });

    await expect(starter.start(request(), control)).resolves.toMatchObject({ placement: "core" });

    expect(clock.pending()).toEqual([ROOT_RESOLVE_TIMEOUT_MS]);
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(calls[0]).toMatchObject({
      method: "terminal.run",
      params: { cwd: "/home/owner/project" },
    });
    await clock.advance(ROOT_RESOLVE_TIMEOUT_MS);
    expect(clock.pending()).toEqual([]);
  });

  test("rejects an outside folder after all roots settle even when one root is missing", async () => {
    const statFs = new MapFs();
    statFs.directories.add("/etc");
    const { starter, runner, calls } = setup({
      roots: ["/home/owner", "/offline"],
      statFs,
    });

    await expect(starter.start(request({ folder: "/etc" }), control)).rejects.toMatchObject({
      status: 422,
      code: "folder_not_allowed",
    });
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects an outside folder when no allowed root resolves", async () => {
    const statFs: StatFs = {
      async realPath(path) {
        if (path === "/etc") return path;
        throw new Error("root is unavailable");
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const { starter, runner, calls } = setup({
      roots: ["/offline-a", "/offline-b"],
      statFs,
    });

    await expect(starter.start(request({ folder: "/etc" }), control)).rejects.toMatchObject({
      status: 422,
      code: "folder_not_allowed",
    });
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("catalog lists home first, de-duplicates canonical aliases, and keeps unavailable roots", async () => {
    const statFs = new MapFs();
    statFs.canonicalPaths.set("/linked/workspace", "/workspace");
    const { starter } = setup({
      roots: ["/linked/workspace", "/workspace", "/offline"],
      statFs,
    });

    await expect(starter.catalog()).resolves.toMatchObject({
      roots: ["/home/owner", "/workspace", "/offline"],
      home: "/home/owner",
    });
  });

  test("catalog waits at most five seconds for an extra root and lists its configured spelling", async () => {
    const clock = new ManualClock();
    const never = new Promise<string>(() => {});
    const statFs: StatFs = {
      async realPath(path) {
        if (path === "/offline") return await never;
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const { starter } = setup({ clock, roots: ["/home/owner", "/offline"], statFs });
    const catalog = starter.catalog();
    await settle();
    expect(clock.pending()).toEqual([ROOT_RESOLVE_TIMEOUT_MS]);

    await clock.advance(ROOT_RESOLVE_TIMEOUT_MS);
    await expect(catalog).resolves.toMatchObject({
      roots: ["/home/owner", "/offline"],
      home: "/home/owner",
    });
    await expect(starter.start(request(), control)).resolves.toMatchObject({ placement: "core" });
    expect(clock.pending()).toEqual([]);
  });

  test("lists a symlinked home by the same canonical spelling as its root", async () => {
    const statFs = new MapFs();
    statFs.canonicalPaths.set("/linked/home", "/home/owner");
    const { starter } = setup({
      home: "/linked/home",
      roots: ["/home/owner"],
      statFs,
    });

    await expect(starter.catalog()).resolves.toMatchObject({
      home: "/home/owner",
      roots: ["/home/owner"],
    });
  });

  test("refuses an outside folder after five seconds when an extra root never settles", async () => {
    const clock = new ManualClock();
    const never = new Promise<string>(() => {});
    const statFs: StatFs = {
      async realPath(path) {
        if (path === "/offline") return await never;
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const { starter, runner, calls } = setup({
      clock,
      roots: ["/home/owner", "/offline"],
      statFs,
    });
    const starting = starter.start(request({ folder: "/etc" }), control);
    await settle();
    expect(clock.pending()).toEqual([ROOT_RESOLVE_TIMEOUT_MS, 10_000]);

    await clock.advance(ROOT_RESOLVE_TIMEOUT_MS);
    await expect(starting).rejects.toMatchObject({
      status: 422,
      code: "folder_not_allowed",
      message: "That folder is outside the allowed roots.",
    });
    expect(clock.pending()).toEqual([]);
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects a sibling path that only shares the allowed root's prefix", async () => {
    const statFs = new MapFs();
    statFs.directories.add("/home/a");
    statFs.directories.add("/home/ab/project");
    const { starter, runner, calls } = setup({ statFs, roots: ["/home/a"] });

    await expect(
      starter.start(request({ folder: "/home/ab/project" }), control),
    ).rejects.toMatchObject({ status: 422, code: "folder_not_allowed" });

    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
    expect(statFs.stats).toEqual([]);
  });

  test("maps a stalled real-path lookup to folder_missing without probing or starting", async () => {
    const clock = new ManualClock();
    const statFs: StatFs = {
      async realPath() {
        return await new Promise<string>(() => {});
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const { starter, runner, calls } = setup({ clock, statFs });
    const pending = starter.start(request(), control);
    for (let index = 0; index < 12 && clock.pending().length === 0; index++) await settle();
    expect(clock.pending()).toEqual([10_000]);
    await clock.advance(10_000);

    await expect(pending).rejects.toMatchObject({
      status: 422,
      code: "folder_missing",
      message: "That folder did not respond in time.",
    });
    expect(clock.pending()).toEqual([]);
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("maps a stalled stat lookup to folder_missing without probing or starting", async () => {
    const clock = new ManualClock();
    const statFs: StatFs = {
      async realPath(path) {
        return path;
      },
      async stat() {
        return await new Promise<{ isDirectory(): boolean }>(() => {});
      },
    };
    const { starter, runner, calls } = setup({ clock, statFs });
    const pending = starter.start(request(), control);
    for (let index = 0; index < 12 && clock.pending().length === 0; index++) await settle();
    expect(clock.pending()).toEqual([10_000]);
    await clock.advance(10_000);

    await expect(pending).rejects.toMatchObject({
      status: 422,
      code: "folder_missing",
      message: "That folder did not respond in time.",
    });
    expect(clock.pending()).toEqual([]);
    expect(runner.argv).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("writes one structured audit line for a successful core placement", async () => {
    const output: string[] = [];
    const { starter } = setup({ clock: new ManualClock(), output: (line) => output.push(line) });

    await starter.start(
      request({ run: { kind: "template", name: "review" }, task: "private first message" }),
      control,
    );

    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("private first message");
    expect(parseAuditLine(output[0] as string)).toEqual({
      time: "1970-01-01T00:00:01.000Z",
      device: { id: "device-9", name: "Phone", role: "control" },
      run: { kind: "template", name: "review" },
      folder: "/home/owner/project",
      placement: "core",
      address: "t27",
      space: { id: "sp-existing", isNew: false },
      tab: { id: "tb-new", isNew: true },
    });
  });

  test("writes one structured audit line for a successful window placement", async () => {
    const output: string[] = [];
    const { starter, runner } = setup({
      clock: new ManualClock(),
      output: (line) => output.push(line),
    });
    runner.lsExitCode = 0;
    runner.doOutput = '{"address":"t41","space_id":"sp-existing","tab_id":"tb41"}';

    await starter.start(request({ task: "private first message" }), control);

    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("private first message");
    expect(parseAuditLine(output[0] as string)).toEqual({
      time: "1970-01-01T00:00:01.000Z",
      device: { id: "device-9", name: "Phone", role: "control" },
      run: { kind: "program", id: "claude" },
      folder: "/home/owner/project",
      placement: "window",
      address: "t41",
      space: { id: "sp-existing", isNew: false },
      tab: { id: "tb41", isNew: true },
    });
  });

  test("does not fall back to core when herdr-app do fails", async () => {
    const { starter, runner, calls } = setup();
    runner.lsExitCode = 0;
    runner.doExitCode = 1;
    runner.doError = "Herdr could not create the tab";

    await expect(starter.start(request(), control)).rejects.toMatchObject({
      status: 409,
      code: "herdr_app_failed",
      message: "Herdr could not create the tab",
    });
    expect(runner.argv).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  test("maps a hanging herdr-app do to 504 and kills the child", async () => {
    const clock = new ManualClock();
    const { starter, runner } = setup({ clock });
    runner.lsExitCode = 0;
    runner.hangDo = true;
    const promise = starter.start(request(), control);
    for (let index = 0; index < 12 && runner.children.length < 2; index++) await settle();
    expect(clock.pending()).toEqual([10_000]);
    expect(runner.argv).toHaveLength(2);
    expect(runner.children[1]).toBeInstanceOf(HangingChild);
    await clock.advance(10_000);

    await expect(promise).rejects.toMatchObject({ status: 504, code: "herdr_app_timeout" });
    expect(clock.pending()).toEqual([]);
    expect((runner.children[1] as HangingChild).killed).toBe(true);
  });

  test("returns the core error kind on a failed terminal.run", async () => {
    const coreError = new HcRpcError({
      code: -32000,
      message: "invalid template",
      data: { kind: "invalid_template" },
    });
    const { starter, runner } = setup({
      coreCall: async (method) => {
        if (method === "templates.list") {
          return { templates: [{ name: "review", description: "Review" }] };
        }
        throw coreError;
      },
    });

    await expect(
      starter.start(request({ run: { kind: "template", name: "review" } }), control),
    ).rejects.toMatchObject({
      status: 502,
      code: "core_unavailable",
      kind: "invalid_template",
    });
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
  });

  test("returns built-ins and a templates error from catalog without blocking the form", async () => {
    const { starter, runner } = setup({
      coreCall: async () => {
        throw new Error("core offline");
      },
    });
    runner.lsExitCode = 0;
    const catalog = await starter.catalog();

    expect(catalog).toEqual({
      programs: ["claude", "codex", "aider"],
      templates: [],
      templatesError: "core offline",
      roots: ["/home/owner", "/workspace"],
      home: "/home/owner",
      windowOpen: true,
    });
  });
});
