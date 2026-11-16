import { describe, expect, test } from "bun:test";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { handleAgentsRoutes } from "./agents-routes.ts";
import type { AppCliContext } from "./app-cli.ts";
import { headerCaller } from "./caller.ts";
import { DeviceStore, type StoreFs } from "./devices.ts";
import type { ApiContext } from "./routes.ts";
import { dispatchApi } from "./routes.ts";
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
  private readonly stdoutText: string;

  constructor(stdoutText = "{}", exitCode = 1) {
    this.stdoutText = stdoutText;
    this.exited = Promise.resolve(exitCode);
  }
  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdoutText) onData(new TextEncoder().encode(this.stdoutText));
    onEnd();
  }
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {}
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    return new FakeChild();
  }
}

async function setup(roots = ["/home/owner"]) {
  const devices = await DeviceStore.open(new MapFs(), "/state/devices.json");
  await devices.add({ token: "control-token", role: "control", name: "Control phone" });
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
      if (method === "templates.list") return { templates: [] };
      return {};
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

  test("returns 404 for the retired start route", async () => {
    const { context, runner, coreCalls, resolveCaller } = await setup();
    const response = await dispatchApi(
      routeRequest("/api/agents/start", "control-token", "POST", "{}"),
      resolveCaller,
      { api: {} as ApiContext, appCli: context },
    );

    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "not_found" });
    expect(runner.argv).toEqual([]);
    expect(coreCalls).toEqual([]);
  });
});
