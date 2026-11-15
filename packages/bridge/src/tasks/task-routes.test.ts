import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type { DeviceRecordView, TasksDocument } from "@herdr-mobile/protocol";
import { TASKS_DOC_NAME } from "@herdr-mobile/protocol";
import { systemClock } from "../prototype/deadline.ts";
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
  constructor(stdout: string, code: number) {
    this.stdout = stdout;
    this.exited = Promise.resolve(code);
  }
  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdout) onData(new TextEncoder().encode(this.stdout));
    onEnd();
  }
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {}
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  windowOpen = false;
  doOutput = '{"address":"t-new","space_id":"sp1","tab_id":"tb1"}';
  doExitCode = 0;
  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    if (argv[1] === "ls") return new FakeChild("{}", this.windowOpen ? 0 : 1);
    return new FakeChild(this.doOutput, this.doExitCode);
  }
}

class FakeCore {
  value: TasksDocument = { v: 1, tasks: {} };
  version = 0;
  live: Array<Record<string, unknown>> = [];
  readonly methods: string[] = [];

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
    if (method === "templates.list") return { templates: [] };
    if (method === "terminal.run") return { address: "t-new" };
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

async function setup(options: { windowOpen?: boolean; startExit?: number } = {}) {
  const devices = await DeviceStore.open(new FakeFs(), "/state/devices.json");
  await devices.add({ token: "control", role: "control", name: control.name });
  await devices.add({ token: "watch", role: "watch", name: watch.name });
  const resolveCaller: ResolveCaller = async (request) => {
    const token = request.headers.get("Authorization")?.slice("Bearer ".length);
    const device = token === "watch" ? watch : token === "control" ? control : undefined;
    return device ? { device } : undefined;
  };
  const runner = new FakeRunner();
  runner.windowOpen = options.windowOpen ?? false;
  runner.doExitCode = options.startExit ?? 0;
  const core = new FakeCore();
  const clock = systemClock;
  const starter = new AgentStarter({
    runner,
    programs: ["claude", "codex"],
    roots: ["/home/owner"],
    home: "/home/owner",
    herdrAppPath: "/opt/herdr-app",
    hcPath: "/opt/hc",
    env: { HOME: "/home/owner", PATH: "/usr/bin" },
    cwd: "/repo",
    clock,
    statFs: {
      async realPath(path) {
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    },
    coreCall: core.call,
  });
  const store = await TaskStore.open(core.call, clock);
  const context = { starter, store, coreCall: core.call };
  return { context, resolveCaller, core, runner, store };
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

  test("writes nothing when the start fails", async () => {
    const { context, resolveCaller, core } = await setup({ windowOpen: true, startExit: 1 });
    const response = await handleTaskRoutes(
      responseRequest("/api/tasks", "control", taskBody),
      context,
      resolveCaller,
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: "herdr_app_failed" });
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

  test("checks a from-Herdr terminal and returns task_not_found for a missing id", async () => {
    const { context, resolveCaller, store } = await setup();
    const checked = await handleTaskRoutes(
      responseRequest("/api/tasks/check", "control", { terminal: "t-mac", turn: 4 }),
      context,
      resolveCaller,
    );
    const checkedRecord = (await checked?.json()) as { id: string };
    const missing = await handleTaskRoutes(
      responseRequest("/api/tasks/uncheck", "control", { id: "tkmissing" }),
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
    core.live = [{ address: "t-live", state: "live" }];
    const clear = await handleTaskRoutes(
      responseRequest("/api/tasks/clear", "control", {}),
      context,
      resolveCaller,
    );

    expect(link?.status).toBe(200);
    expect(linked).toMatchObject({ terminal: "t-live" });
    expect(duplicate?.status).toBe(409);
    expect(await duplicate?.json()).toEqual({ error: "task_linked" });
    expect(await clear?.json()).toEqual({ removed: [] });
    expect(store.snapshot().tasks[created.id]).toBeDefined();
  });
});
