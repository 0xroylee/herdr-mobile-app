import { describe, expect, test } from "bun:test";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { handleAgentsRoutes } from "./agents-routes.ts";
import type { AppCliContext } from "./app-cli.ts";
import { headerCaller } from "./caller.ts";
import { DeviceStore, type StoreFs } from "./devices.ts";
import { AgentStarter } from "./start-agent.ts";

class MapFs implements StoreFs {
  readonly files = new Map<string, string>();
  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async mkdir(): Promise<void> {}
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(from: string, to: string): Promise<void> {
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error("missing temporary file");
    this.files.delete(from);
    this.files.set(to, contents);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  killed = false;
  private readonly stdoutText: string;

  constructor(stdoutText = "", exitCode = 1) {
    this.stdoutText = stdoutText;
    this.exited = Promise.resolve(exitCode);
  }
  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdoutText) onData(new TextEncoder().encode(this.stdoutText));
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    return new FakeChild("{}", argv[1] === "ls" ? 1 : 0);
  }
}

async function setup(roots = ["/home/owner"]) {
  const devices = await DeviceStore.open(new MapFs(), "/state/devices.json");
  await devices.add({ token: "control-token", role: "control", name: "Control phone" });
  await devices.add({ token: "watch-token", role: "watch", name: "Watch phone" });
  const runner = new FakeRunner();
  const context: AppCliContext = {
    runner,
    env: { HOME: "/home/owner", PATH: "/usr/bin" },
    cwd: "/repo",
    herdrAppPath: "/opt/herdr-app",
  };
  const coreCalls: { method: string; params: unknown }[] = [];
  const starter = new AgentStarter({
    runner,
    programs: ["claude", "codex"],
    roots,
    home: "/home/owner",
    herdrAppPath: context.herdrAppPath,
    hcPath: "/opt/hc",
    env: context.env,
    cwd: context.cwd,
    statFs: {
      async realPath(path) {
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    },
    coreCall: async (method, params) => {
      coreCalls.push({ method, params });
      return { address: "t31", templates: [] };
    },
  });
  return {
    context,
    starter,
    runner,
    coreCalls,
    resolveCaller: headerCaller({ ownerLogin: "owner@example.com" }, undefined, devices),
  };
}

function routeRequest(path: string, token: string, method = "GET", body?: string): Request {
  return new Request(`http://bridge${path}`, {
    method,
    headers: {
      "Tailscale-User-Login": "owner@example.com",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
  });
}

describe("agent routes", () => {
  test("returns the catalog to a control device", async () => {
    const { starter, runner, coreCalls, resolveCaller } = await setup();
    const response = await handleAgentsRoutes(
      routeRequest("/api/agents/catalog", "control-token"),
      starter,
      resolveCaller,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      programs: ["claude", "codex"],
      templates: [],
      roots: ["/home/owner"],
      home: "/home/owner",
      windowOpen: false,
    });
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(coreCalls).toEqual([{ method: "templates.list", params: {} }]);
  });

  test("de-duplicates normalized roots in the catalog", async () => {
    const { starter, resolveCaller } = await setup(["/home/owner", "/home/owner/../owner"]);
    const response = await handleAgentsRoutes(
      routeRequest("/api/agents/catalog", "control-token"),
      starter,
      resolveCaller,
    );

    expect(await response?.json()).toMatchObject({ roots: ["/home/owner"] });
  });

  test("denies a watch device before reading the body or spawning a process", async () => {
    const { starter, runner, coreCalls, resolveCaller } = await setup();
    const response = await handleAgentsRoutes(
      routeRequest("/api/agents/start", "watch-token", "POST", "not json"),
      starter,
      resolveCaller,
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "forbidden" });
    expect(runner.argv).toEqual([]);
    expect(coreCalls).toEqual([]);
  });

  test("rejects malformed and shell-line bodies with 400", async () => {
    const { starter, runner, coreCalls, resolveCaller } = await setup();
    const malformed = await handleAgentsRoutes(
      routeRequest("/api/agents/start", "control-token", "POST", "{"),
      starter,
      resolveCaller,
    );
    const withLine = await handleAgentsRoutes(
      routeRequest(
        "/api/agents/start",
        "control-token",
        "POST",
        JSON.stringify({
          run: { kind: "program", id: "claude" },
          folder: "/home/owner/project",
          space: { kind: "existing", id: "sp1" },
          line: "echo unsafe",
        }),
      ),
      starter,
      resolveCaller,
    );

    expect(malformed?.status).toBe(400);
    expect(withLine?.status).toBe(400);
    expect(runner.argv).toEqual([]);
    expect(coreCalls).toEqual([]);
  });

  test("starts a valid request and returns the starter reply", async () => {
    const { starter, runner, coreCalls, resolveCaller } = await setup();
    const response = await handleAgentsRoutes(
      routeRequest(
        "/api/agents/start",
        "control-token",
        "POST",
        JSON.stringify({
          run: { kind: "program", id: "claude" },
          folder: "/home/owner/project",
          space: { kind: "new", name: "Review" },
        }),
      ),
      starter,
      resolveCaller,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ placement: "core", address: "t31" });
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(coreCalls).toHaveLength(1);
    expect(coreCalls[0]?.method).toBe("terminal.run");
  });

  test("returns the core placement's first-message restriction to the caller", async () => {
    const { starter, runner, coreCalls, resolveCaller } = await setup();
    const response = await handleAgentsRoutes(
      routeRequest(
        "/api/agents/start",
        "control-token",
        "POST",
        JSON.stringify({
          run: { kind: "program", id: "claude" },
          folder: "/home/owner/project",
          space: { kind: "new", name: "Review" },
          task: "--dangerously-skip-permissions",
        }),
      ),
      starter,
      resolveCaller,
    );

    expect(response?.status).toBe(422);
    expect(await response?.json()).toEqual({
      error: "run_not_allowed",
      message:
        "First messages for claude need Herdr open on your Mac. Open Herdr, or leave the message empty.",
    });
    expect(runner.argv).toEqual([["/opt/herdr-app", "ls"]]);
    expect(coreCalls).toEqual([]);
  });
});
