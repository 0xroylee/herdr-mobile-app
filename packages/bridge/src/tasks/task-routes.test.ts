import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type { DeviceRecordView, TaskRecord, TasksDocument } from "@herdr-mobile/protocol";
import { TASKS_DOC_NAME } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import type { ResolveCaller } from "../server/caller.ts";
import { DeviceStore, type StoreFs } from "../server/devices.ts";
import { AgentStarter } from "../server/start-agent.ts";
import { handleTaskRoutes } from "./task-routes.ts";
import { type TaskCoreCaller, TaskStore } from "./task-store.ts";

class FakeFs implements StoreFs {
  async readFile(): Promise<string | undefined> {
    return undefined;
  }
  async mkdir(): Promise<void> {}
  async writeFile(): Promise<void> {}
  async rename(): Promise<void> {}
  async unlink(): Promise<void> {}
}

class FakeChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  private readonly stdout: string;
  private readonly stderr: string;
  constructor(stdout: string, code: number, stderr = "", hang = false) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exited = hang ? new Promise(() => {}) : Promise.resolve(code);
  }
  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdout) onData(new TextEncoder().encode(this.stdout));
    onEnd();
  }
  readStderr(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stderr) onData(new TextEncoder().encode(this.stderr));
    onEnd();
  }
  kill(): void {}
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  readonly clock: FakeClock;
  windowOpen = false;
  doOutput = '{"address":"t-new","space_id":"sp1","tab_id":"tb1"}';
  doExitCode = 0;
  doStderr = "";
  hangStart = false;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    if (argv[1] === "ls") return new FakeChild("{}", this.windowOpen ? 0 : 1);
    const hang = argv[1] === "do" && this.hangStart;
    if (hang) queueMicrotask(() => this.clock.fireTimeout(10_000));
    return new FakeChild(this.doOutput, this.doExitCode, this.doStderr, hang);
  }
}

class FakeClock implements Clock {
  private nextId = 0;
  private readonly timers = new Map<number, { callback: () => void; ms: number }>();
  now(): number {
    return 1_000_000;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { callback, ms });
    if (ms === 1_000) queueMicrotask(() => this.fireTimer(id));
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }
  fireTimeout(ms: number): void {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.ms === ms);
    if (entry) this.fireTimer(entry[0]);
  }
  private fireTimer(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    this.timers.delete(id);
    timer.callback();
  }
}

class FakeCore {
  value: TasksDocument = { v: 1, tasks: {} };
  version = 0;
  live: Array<Record<string, unknown>> = [];
  readonly methods: string[] = [];
  readonly runParams: unknown[] = [];
  runFailure: Error | undefined;

  readonly call: TaskCoreCaller = async (method, params) => {
    this.methods.push(method);
    if (method === "doc.get") {
      expect(params).toEqual({ name: TASKS_DOC_NAME });
      return { value: structuredClone(this.value), version: this.version };
    }
    if (method === "doc.set") {
      const input = params as { name: string; version: number; value: TasksDocument };
      expect(input.name).toBe(TASKS_DOC_NAME);
      if (input.version !== this.version) {
        throw new HcRpcError({
          code: -32000,
          message: "version conflict",
          data: { kind: "conflict" },
        });
      }
      this.value = structuredClone(input.value);
      this.version += 1;
      return { version: this.version };
    }
    if (method === "terminal.list") return { terminals: structuredClone(this.live) };
    if (method === "templates.list") {
      return { templates: [{ name: "review", description: "Review" }] };
    }
    if (method === "terminal.run") {
      this.runParams.push(structuredClone(params));
      if (this.runFailure) throw this.runFailure;
      return { address: "t-new" };
    }
    throw new Error(`unexpected method ${method}`);
  };
}

const control: DeviceRecordView = {
  id: "device-control",
  name: "Control phone",
  role: "control",
  createdAt: 1,
  lastSeenAt: null,
};
const watch: DeviceRecordView = { ...control, id: "device-watch", role: "watch" };

function responseRequest(
  path: string,
  token: "control" | "watch" = "control",
  body: unknown = {},
  method = "POST",
): Request {
  return new Request(`http://bridge${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

interface SetupOptions {
  windowOpen?: boolean;
  startExit?: number;
  startStderr?: string;
  hangStart?: boolean;
  doOutput?: string;
  programs?: string[];
  realPaths?: Record<string, string>;
  initialDocument?: TasksDocument;
}

async function setup(options: SetupOptions = {}) {
  const devices = await DeviceStore.open(new FakeFs(), "/state/devices.json");
  await devices.add({ token: "control", role: "control", name: control.name });
  await devices.add({ token: "watch", role: "watch", name: watch.name });
  const resolveCaller: ResolveCaller = async (request) => {
    const token = request.headers.get("Authorization")?.slice("Bearer ".length);
    const device = token === "watch" ? watch : token === "control" ? control : undefined;
    return device ? { device } : undefined;
  };
  const clock = new FakeClock();
  const runner = new FakeRunner(clock);
  runner.windowOpen = options.windowOpen ?? false;
  runner.doExitCode = options.startExit ?? 0;
  runner.doStderr = options.startStderr ?? "";
  runner.hangStart = options.hangStart ?? false;
  runner.doOutput = options.doOutput ?? runner.doOutput;
  const core = new FakeCore();
  if (options.initialDocument) core.value = structuredClone(options.initialDocument);
  const realPathCalls: string[] = [];
  const starter = new AgentStarter({
    runner,
    programs: options.programs ?? ["claude", "codex"],
    roots: ["/home/owner"],
    home: "/home/owner",
    herdrAppPath: "/opt/herdr-app",
    hcPath: "/opt/hc",
    env: { HOME: "/home/owner", PATH: "/usr/bin" },
    cwd: "/repo",
    clock,
    statFs: {
      async realPath(path) {
        realPathCalls.push(path);
        return options.realPaths?.[path] ?? path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    },
    coreCall: core.call,
  });
  const store = await TaskStore.open(core.call, clock);
  const context = { starter, store, coreCall: core.call };
  return { context, resolveCaller, core, runner, store, realPathCalls };
}

const taskBody = {
  text: "Review the task route",
  run: { kind: "program", id: "claude" },
  folder: "/home/owner/project",
  space: { kind: "existing", id: "sp1" },
};

describe("task routes", () => {
  test("denies watch devices on every task route before reading the body", async () => {
    const { context, resolveCaller, core } = await setup();
    for (const path of [
      "/api/tasks",
      "/api/tasks/check",
      "/api/tasks/uncheck",
      "/api/tasks/link",
      "/api/tasks/clear",
    ]) {
      let bodyRead = false;
      const request = responseRequest(path, "watch", "invalid");
      Object.defineProperty(request, "text", {
        value: async () => {
          bodyRead = true;
          return "invalid";
        },
      });
      const response = await handleTaskRoutes(request, context, resolveCaller);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ error: "forbidden" });
      expect(bodyRead).toBe(false);
    }
    expect(core.methods).toEqual(["doc.get"]);
  });

  test("rejects unknown body keys and malformed JSON before starting or writing", async () => {
    const { context, resolveCaller, runner, core } = await setup();
    const unknownBodies = [
      ["/api/tasks", { ...taskBody, extra: true }],
      ["/api/tasks/check", { id: "tk1", turn: 1, extra: true }],
      ["/api/tasks/uncheck", { id: "tk1", extra: true }],
      ["/api/tasks/link", { id: "tk1", terminal: "t1", extra: true }],
      ["/api/tasks/clear", { spaceId: "sp1", extra: true }],
    ] as const;
    for (const [path, body] of unknownBodies) {
      const unknown = await handleTaskRoutes(
        responseRequest(path, "control", body),
        context,
        resolveCaller,
      );
      expect(unknown?.status).toBe(400);
      expect(await unknown?.json()).toEqual({ error: "bad_request" });
    }
    const malformed = new Request("http://bridge/api/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer control" },
      body: "{",
    });
    const badJson = await handleTaskRoutes(malformed, context, resolveCaller);

    expect(badJson?.status).toBe(400);
    expect(runner.argv).toEqual([]);
    expect(core.methods).toEqual(["doc.get"]);
  });

  test("rejects prototype task ids and terminal addresses before any task write", async () => {
    const { context, resolveCaller, core, store } = await setup();
    const unchecked = await store.create({
      text: "Keep this unchecked record",
      run: { kind: "program", id: "claude" },
      folder: "/home/owner/project",
    });
    const beforeWrites = core.methods.filter((method) => method === "doc.set").length;
    const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);

    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const [path, body] of [
        ["/api/tasks/check", { id: key, turn: 0 }],
        ["/api/tasks/check", { terminal: key, turn: 0 }],
        ["/api/tasks/uncheck", { id: key }],
        ["/api/tasks/link", { id: unchecked.id, terminal: key }],
      ] as const) {
        const response = await handleTaskRoutes(
          responseRequest(path, "control", body),
          context,
          resolveCaller,
        );
        expect(response?.status).toBe(400);
        expect(await response?.json()).toEqual({ error: "bad_request" });
      }
    }

    expect(core.methods.filter((method) => method === "doc.set")).toHaveLength(beforeWrites);
    expect(store.snapshot().tasks[unchecked.id]).toEqual(unchecked);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(descriptors);
  });

  test("starts first, writes the record, and returns record plus start", async () => {
    const { context, resolveCaller, core } = await setup();
    const response = await handleTaskRoutes(
      responseRequest("/api/tasks", "control", taskBody),
      context,
      resolveCaller,
    );
    const body = (await response?.json()) as { record: { id: string }; start: { address: string } };

    expect(response?.status).toBe(200);
    expect(body.record.id).toMatch(/^tk[0-9a-f]{32}$/u);
    expect(body).toMatchObject({
      record: {
        origin: "phone",
        terminal: "t-new",
        text: "Review the task route",
        space: { id: "sp1" },
      },
      start: { placement: "core", address: "t-new" },
    });
    expect(core.methods).toEqual(["doc.get", "terminal.run", "terminal.list", "doc.set"]);
    expect(core.value.tasks[body.record.id]?.terminal).toBe("t-new");
  });

  test("keeps the window task field and argv program-only", async () => {
    const { context, resolveCaller, runner, core } = await setup({ windowOpen: true });
    const response = await handleTaskRoutes(
      responseRequest("/api/tasks", "control", taskBody),
      context,
      resolveCaller,
    );
    const args = JSON.parse(runner.argv[1]?.[3] ?? "{}") as Record<string, unknown>;

    expect(response?.status).toBe(200);
    expect(args).toEqual({
      folder: "/home/owner/project",
      argv: ["claude"],
      task: "Review the task route",
      space: "sp1",
    });
    expect(core.methods).toContain("doc.set");
  });

  test("stores the verified real folder for tilde and symlinked unlinked window starts", async () => {
    const { context, resolveCaller, runner, store, realPathCalls } = await setup({
      windowOpen: true,
      doOutput: "{}",
      realPaths: {
        "/home/owner/link": "/home/owner/real/project",
      },
    });
    const folders = [
      { requested: "~/project", resolved: "/home/owner/project" },
      { requested: "/home/owner/link", resolved: "/home/owner/real/project" },
    ];

    for (const { requested, resolved } of folders) {
      const response = await handleTaskRoutes(
        responseRequest("/api/tasks", "control", { ...taskBody, folder: requested }),
        context,
        resolveCaller,
      );
      const body = (await response?.json()) as { record: { id: string } };
      const record = store.snapshot().tasks[body.record.id];
      const args = runner.argv
        .filter((argv) => argv[1] === "do")
        .map((argv) => JSON.parse(argv[3] ?? "{}") as Record<string, unknown>)
        .at(-1);

      expect(response?.status).toBe(200);
      expect(record?.folder).toBe(resolved);
      expect(record).not.toHaveProperty("terminal");
      expect(args?.folder).toBe(resolved);
    }
    expect(realPathCalls.filter((path) => path === "/home/owner/project")).toHaveLength(1);
    expect(realPathCalls.filter((path) => path === "/home/owner/link")).toHaveLength(1);
  });

  test("writes nothing when the start fails", async () => {
    const { context, resolveCaller, core } = await setup({
      windowOpen: true,
      startExit: 1,
      startStderr: "private stderr detail",
    });
    const response = await handleTaskRoutes(
      responseRequest("/api/tasks", "control", taskBody),
      context,
      resolveCaller,
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "herdr_app_failed",
      message: "Herdr couldn’t start the task.",
    });
    expect(core.methods).toEqual(["doc.get"]);
    expect(Object.keys(core.value.tasks)).toHaveLength(0);
  });

  test("uses task_not_allowed for one-word and dash-leading core-path text", async () => {
    const { context, resolveCaller, core } = await setup();
    for (const text of ["Inspect", "-p inspect the change"]) {
      const response = await handleTaskRoutes(
        responseRequest("/api/tasks", "control", { ...taskBody, text }),
        context,
        resolveCaller,
      );
      expect(response?.status).toBe(422);
      expect(await response?.json()).toEqual({
        error: "task_not_allowed",
        message: "Write the task as a sentence.",
      });
    }
    expect(core.methods).toEqual(["doc.get"]);
  });

  test("rejects empty task text before starting", async () => {
    const { context, resolveCaller, core } = await setup();
    const response = await handleTaskRoutes(
      responseRequest("/api/tasks", "control", { ...taskBody, text: "" }),
      context,
      resolveCaller,
    );

    expect(response?.status).toBe(422);
    expect(await response?.json()).toEqual({
      error: "task_not_allowed",
      message: "Write the task as a sentence.",
    });
    expect(core.methods).toEqual(["doc.get"]);
  });

  test.each([
    ["one-word", "Inspect"],
    ["dash-leading", "-p inspect the change"],
  ])("accepts %s template text on both start paths", async (_name, text) => {
    for (const windowOpen of [false, true]) {
      const { context, resolveCaller, core, runner } = await setup({ windowOpen });
      const response = await handleTaskRoutes(
        responseRequest("/api/tasks", "control", {
          ...taskBody,
          text,
          run: { kind: "template", name: "review" },
        }),
        context,
        resolveCaller,
      );

      expect(response?.status).toBe(200);
      if (windowOpen) {
        const args = JSON.parse(runner.argv[1]?.[3] ?? "{}") as Record<string, unknown>;
        expect(args).toMatchObject({ argv: ["review"], task: text });
      } else {
        expect(core.runParams[0]).toMatchObject({ argv: ["review", text] });
      }
    }
  });

  test("uses fixed task-start copy for every start and storage error", async () => {
    const tasks: Record<string, TaskRecord> = {};
    for (let index = 0; index < 130; index += 1) {
      const id = `tk${index.toString(16).padStart(32, "0")}`;
      tasks[id] = {
        id,
        origin: "phone",
        text: "x".repeat(8 * 1024),
        run: { kind: "program", id: "claude" },
        folder: "/home/owner/project",
        createdAt: index + 1,
      };
    }
    const failures = [
      {
        options: { windowOpen: true, startExit: 1, startStderr: "private stderr" },
        body: taskBody,
        status: 409,
        error: "herdr_app_failed",
        message: "Herdr couldn’t start the task.",
      },
      {
        options: { windowOpen: true, hangStart: true },
        body: taskBody,
        status: 504,
        error: "herdr_app_timeout",
        message: "Herdr took too long to start the task.",
      },
      {
        options: {},
        body: taskBody,
        configure: (core: FakeCore) => {
          core.runFailure = new Error("private transport detail");
        },
        status: 502,
        error: "core_unavailable",
        message: "Can’t reach your Mac.",
      },
      {
        options: {},
        body: { ...taskBody, folder: "/etc" },
        status: 422,
        error: "folder_not_allowed",
        message: "Choose a folder under an allowed root.",
      },
      {
        options: {},
        body: { ...taskBody, run: { kind: "program", id: "bash" } },
        status: 422,
        error: "run_not_allowed",
        message: "That agent isn’t available.",
      },
      {
        options: { programs: ["claude", "codex", "aider"] },
        body: { ...taskBody, run: { kind: "program", id: "aider" } },
        status: 422,
        error: "run_not_allowed",
        message: "aider gets a first message only while Herdr is open on your Mac.",
      },
      {
        options: {},
        body: { ...taskBody, text: "Inspect" },
        status: 422,
        error: "task_not_allowed",
        message: "Write the task as a sentence.",
      },
      {
        options: { initialDocument: { v: 1, tasks } },
        body: taskBody,
        status: 507,
        error: "tasks_full",
        message: "Check off and clear old tasks first.",
      },
    ] satisfies Array<{
      options: SetupOptions;
      body: unknown;
      status: number;
      error: string;
      message: string;
      configure?: (core: FakeCore) => void;
    }>;

    for (const failure of failures) {
      const { context, resolveCaller, core } = await setup(failure.options);
      failure.configure?.(core);
      const response = await handleTaskRoutes(
        responseRequest("/api/tasks", "control", failure.body),
        context,
        resolveCaller,
      );
      const body = (await response?.json()) as Record<string, unknown>;

      expect(response?.status).toBe(failure.status);
      expect(body).toEqual({ error: failure.error, message: failure.message });
    }
  });

  test("checks a from-Herdr terminal and returns task_not_found for a missing id", async () => {
    const { context, resolveCaller, store } = await setup();
    const checked = await handleTaskRoutes(
      responseRequest("/api/tasks/check", "control", { terminal: "t-mac", turn: 4 }),
      context,
      resolveCaller,
    );
    const checkedRecord = (await checked?.json()) as { id: string };
    const missing = await handleTaskRoutes(
      responseRequest("/api/tasks/uncheck", "control", { id: `tk${"f".repeat(32)}` }),
      context,
      resolveCaller,
    );

    expect(checked?.status).toBe(200);
    expect(store.snapshot().tasks[checkedRecord.id]).toMatchObject({
      origin: "herdr",
      terminal: "t-mac",
      checkedTurn: 4,
    });
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toEqual({ error: "task_not_found" });
  });

  test("links once and clears only ended records", async () => {
    const { context, resolveCaller, store, core } = await setup();
    const created = await store.create({
      text: "Review another task",
      run: { kind: "program", id: "claude" },
      folder: "/home/owner/project",
    });
    const link = await handleTaskRoutes(
      responseRequest("/api/tasks/link", "control", { id: created.id, terminal: "t-live" }),
      context,
      resolveCaller,
    );
    const linked = await link?.json();
    const duplicate = await handleTaskRoutes(
      responseRequest("/api/tasks/link", "control", { id: created.id, terminal: "t-live" }),
      context,
      resolveCaller,
    );
    await store.check(created.id, 0, control);
    const lost = await store.create({
      text: "Check the lost program",
      run: { kind: "program", id: "claude" },
      folder: "/home/owner/project",
      terminal: "t-lost",
    });
    await store.check(lost.id, 0, control);
    core.live = [
      { address: "t-live", state: "live" },
      { address: "t-lost", state: "live", reason: "signaled" },
    ];
    const clear = await handleTaskRoutes(
      responseRequest("/api/tasks/clear", "control", {}),
      context,
      resolveCaller,
    );

    expect(link?.status).toBe(200);
    expect(linked).toMatchObject({ terminal: "t-live" });
    expect(duplicate?.status).toBe(409);
    expect(await duplicate?.json()).toEqual({ error: "task_linked" });
    expect(await clear?.json()).toEqual({ removed: [lost.id] });
    expect(store.snapshot().tasks[created.id]).toBeDefined();
    expect(store.snapshot().tasks[lost.id]).toBeUndefined();
  });
});
