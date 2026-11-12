import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeCore, flush, frame, line } from "@herdr-mobile/hc-client/testing";
import { BRIDGE_WS_CLOSE_CODES, type DeviceRecordView } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import type { AppCliContext } from "./app-cli.ts";
import { runCli } from "./cli.ts";
import type { BridgeConfig } from "./config.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceFileError, DeviceStore } from "./devices.ts";
import { PairingCodes } from "./pairing.ts";
import type { WebSocketUpgradeTarget } from "./serve.ts";
import { createBridgeFetchHandler, serveBridge, WS_AUTH_TIMEOUT_MS } from "./serve.ts";
import { AgentStarter } from "./start-agent.ts";
import type { StaticFs } from "./static.ts";

interface FakeWebSocketCallbacks {
  open(socket: unknown): void;
  message(socket: unknown, message: string | Uint8Array): void;
  close(socket: unknown): void;
}

interface FakeServeOptions {
  unix?: string;
  hostname?: string;
  port?: number;
  fetch?: (request: Request, server?: WebSocketUpgradeTarget) => Promise<Response | undefined>;
  websocket?: FakeWebSocketCallbacks;
}

class FakeWebSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  readonly data: unknown;

  constructor(data: unknown) {
    this.data = data;
  }

  send(message: string | Uint8Array): void {
    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

class FakeUpgradeServer implements WebSocketUpgradeTarget {
  readonly sockets: FakeWebSocket[] = [];

  upgrade(_request: Request, options: { data: unknown }): boolean {
    this.sockets.push(new FakeWebSocket(options.data));
    return true;
  }
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

  get pending(): number {
    return this.timers.length;
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
  inputClosed = false;
  killed = false;
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
    return this.core.write(bytes);
  }

  closeInput(): void {
    this.inputClosed = true;
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

class FakeOneShotConnect extends FakeConnect {
  override closeInput(): void {
    super.closeInput();
    this.exit(0);
  }
}

class FakeCommand implements OwnedProcess {
  readonly exited: Promise<number | null>;
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
  kill(): void {}
}

class FakeBridgeRunner implements ProcessRunner {
  readonly children: FakeConnect[] = [];
  readonly argv: string[][] = [];
  oneShotCore = false;

  spawn(argv: string[]): OwnedProcess {
    this.argv.push(argv);
    if (argv[0] === "/fake/herdr-app") return new FakeCommand("", "", 1);
    const child = this.oneShotCore ? new FakeOneShotConnect() : new FakeConnect();
    child.core.answer = (method) => {
      if (method === "templates.list") {
        return { templates: [{ name: "review", description: "Review" }] };
      }
      if (method === "terminal.run") return { address: "t-started" };
      return undefined;
    };
    this.children.push(child);
    return child;
  }
}

interface FakeServe {
  calls: FakeServeOptions[];
  admin?: FakeServeOptions;
  web?: FakeServeOptions;
  restore(): void;
}

function fakeServe(): FakeServe {
  const captured: FakeServe = {
    calls: [],
    restore() {},
  };
  const serve = (unknownOptions: unknown) => {
    const options = unknownOptions as FakeServeOptions;
    captured.calls.push(options);
    if (options.unix) {
      writeFileSync(options.unix, "fake admin socket");
      captured.admin = options;
      return { stop() {} };
    }
    captured.web = options;
    return { port: options.port, stop() {} };
  };
  const spy = spyOn(Bun, "serve").mockImplementation(serve as typeof Bun.serve);
  captured.restore = () => spy.mockRestore();
  return captured;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await flush();
}

interface BridgeHarness {
  bridge: Awaited<ReturnType<typeof serveBridge>>;
  clock: FakeClock;
  runner: FakeBridgeRunner;
  serve: FakeServe;
  root: string;
  output: string[];
  upgradeServer: FakeUpgradeServer;
  dispose(): Promise<void>;
}

async function startHarness(): Promise<BridgeHarness> {
  const scratch = join(process.cwd(), ".unshit");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "serve-u4-"));
  const serve = fakeServe();
  const clock = new FakeClock();
  const runner = new FakeBridgeRunner();
  const output: string[] = [];
  const config: BridgeConfig = {
    ownerLogin: "owner@example.com",
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "https://mac.tailnet.ts.net",
    webDir: join(root, "web"),
    hcPath: "/fake/hc",
    herdrAppPath: "/fake/herdr-app",
    programs: ["claude", "codex"],
    roots: [root],
    home: root,
    whois: false,
    stateDir: join(root, "state"),
    deviceFilePath: join(root, "state", "devices.json"),
    adminSocketPath: join(root, "state", "admin.sock"),
    machine: { id: "mac-1", name: "Mac" },
    env: { HOME: root, PATH: "/usr/bin:/bin" },
    cwd: root,
  };

  try {
    const bridge = await serveBridge(config, {
      clock,
      runner,
      stdout: (text) => output.push(text),
    });
    return {
      bridge,
      clock,
      runner,
      serve,
      root,
      output,
      upgradeServer: new FakeUpgradeServer(),
      async dispose() {
        try {
          await bridge.stop();
        } finally {
          serve.restore();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    serve.restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function websocketCallbacks(harness: BridgeHarness): FakeWebSocketCallbacks {
  const callbacks = harness.serve.web?.websocket;
  if (!callbacks) throw new Error("fake Bun server did not receive WebSocket callbacks");
  return callbacks;
}

async function openSocket(harness: BridgeHarness): Promise<FakeWebSocket> {
  const fetch = harness.serve.web?.fetch;
  if (!fetch) throw new Error("fake Bun server did not receive a fetch handler");
  const response = await fetch(request("/ws", ownerHeaders), harness.upgradeServer);
  expect(response).toBeUndefined();
  const socket = harness.upgradeServer.sockets.at(-1);
  if (!socket) throw new Error("fake WebSocket upgrade did not create a socket");
  websocketCallbacks(harness).open(socket);
  return socket;
}

async function authenticate(harness: BridgeHarness, token: string): Promise<FakeWebSocket> {
  const socket = await openSocket(harness);
  websocketCallbacks(harness).message(socket, JSON.stringify({ v: 1, token }));
  await settle();
  return socket;
}

async function adminStatus(harness: BridgeHarness): Promise<{ sessions: number }> {
  const fetch = harness.serve.admin?.fetch;
  if (!fetch) throw new Error("fake Bun server did not receive the admin handler");
  const response = await fetch(new Request("http://admin/status"));
  if (!response) throw new Error("admin status returned no response");
  const status = (await response.json()) as { sessions: number };
  return { sessions: status.sessions };
}

async function withHarness<T>(work: (harness: BridgeHarness) => Promise<T>): Promise<T> {
  const harness = await startHarness();
  try {
    return await work(harness);
  } finally {
    await harness.dispose();
  }
}

class MapStoreFs implements StoreFs {
  async readFile(): Promise<string | undefined> {
    return undefined;
  }
  async mkdir(): Promise<void> {}
  async writeFile(): Promise<void> {}
  async rename(): Promise<void> {}
  async unlink(): Promise<void> {}
}

class FakeRunner implements ProcessRunner {
  spawn(): never {
    throw new Error("unexpected child process");
  }
}

class FakeStaticFs implements StaticFs {
  reads = 0;
  async realpath(path: string): Promise<string> {
    return path;
  }
  async readFile(): Promise<Uint8Array> {
    this.reads++;
    return new TextEncoder().encode("web app");
  }
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://bridge${path}`, { headers });
}

async function setup() {
  const devices = await DeviceStore.open(new MapStoreFs(), "/state/devices.json");
  const pairing = new PairingCodes();
  const staticFs = new FakeStaticFs();
  const identity = { ownerLogin: "owner@example.com" };
  const appCli: AppCliContext = {
    identity,
    devices,
    runner: new FakeRunner(),
    env: {},
    cwd: "/",
    herdrAppPath: "herdr-app",
  };
  const agentStarter = new AgentStarter({
    runner: appCli.runner,
    programs: ["claude", "codex"],
    roots: ["/"],
    home: "/",
    herdrAppPath: appCli.herdrAppPath,
    hcPath: "hc",
    env: appCli.env,
    cwd: appCli.cwd,
    statFs: {
      async realPath(path) {
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    },
    coreCall: async () => ({ templates: [] }),
  });
  const handler = createBridgeFetchHandler({
    api: {
      identity,
      devices,
      pairing,
      machine: { id: "mac-1", name: "Mac" },
      routes: () => ({ direct: "https://mac.tailnet.ts.net" }),
      bridgeKey: () => "a".repeat(43),
    },
    appCli,
    agentStarter,
    identity,
    webDir: "/web",
    staticFs,
  });
  return { handler, staticFs, devices, pairing };
}

const ownerHeaders = { "Tailscale-User-Login": "owner@example.com" };

describe("bridge HTTP dispatch", () => {
  test("refuses a non-loopback host before opening any socket", async () => {
    const config: BridgeConfig = {
      ownerLogin: "owner@example.com",
      host: "0.0.0.0",
      port: 8787,
      publicUrl: "https://mac.tailnet.ts.net",
      webDir: "/web",
      hcPath: "hc",
      herdrAppPath: "herdr-app",
      programs: ["claude", "codex"],
      roots: ["/"],
      home: "/",
      whois: false,
      stateDir: "/state/herdr-bridge",
      deviceFilePath: "/state/herdr-bridge/devices.json",
      adminSocketPath: "/state/herdr-bridge/admin.sock",
      machine: { id: "mac-1", name: "Mac" },
      env: {},
      cwd: "/",
    };
    await expect(serveBridge(config)).rejects.toThrow("bridge host must be 127.0.0.1");
  });

  test("checks identity before serving static files", async () => {
    const { handler, staticFs } = await setup();
    const denied = await handler(request("/", { "Tailscale-User-Login": "other" }));
    expect(denied?.status).toBe(403);
    expect(staticFs.reads).toBe(0);

    const allowed = await handler(request("/", ownerHeaders));
    expect(allowed?.status).toBe(200);
    expect(await allowed?.text()).toBe("web app");
    expect(staticFs.reads).toBe(1);
  });

  test("routes API requests through the existing identity and token checks", async () => {
    const { handler, pairing, devices } = await setup();
    const issued = pairing.issue("control");
    const paired = await handler(
      new Request("http://bridge/api/pair", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ code: issued.code, name: "Phone" }),
      }),
    );
    expect(paired?.status).toBe(201);
    const pairedBody = (await paired?.json()) as { token: string };
    expect(pairedBody).toMatchObject({
      routes: { direct: "https://mac.tailnet.ts.net" },
      bridgeKey: "a".repeat(43),
    });
    expect(await devices.list()).toHaveLength(1);

    const catalog = await handler(
      new Request("http://bridge/api/agents/catalog", {
        headers: { ...ownerHeaders, Authorization: `Bearer ${pairedBody.token}` },
      }),
    );
    expect(catalog?.status).toBe(200);
    expect(await catalog?.json()).toMatchObject({ programs: ["claude", "codex"], templates: [] });

    const health = await handler(request("/api/health", ownerHeaders));
    expect(health?.status).toBe(401);
  });

  test("writes successful start audits through the bridge stdout sink", async () => {
    await withHarness(async (harness) => {
      harness.runner.oneShotCore = true;
      const device = await harness.bridge.devices.add({
        token: "start-output-token",
        role: "control",
        name: "Desk phone",
      });
      const fetch = harness.serve.web?.fetch;
      if (!fetch) throw new Error("fake Bun server did not receive the web handler");
      const response = await fetch(
        new Request("http://bridge/api/agents/start", {
          method: "POST",
          headers: {
            ...ownerHeaders,
            Authorization: "Bearer start-output-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            run: { kind: "template", name: "review" },
            folder: harness.root,
            space: { kind: "new", name: "Review" },
            task: "private first message",
          }),
        }),
        harness.upgradeServer,
      );

      expect(response?.status).toBe(200);
      expect(harness.output).toHaveLength(1);
      expect(harness.output[0]).not.toContain("start-output-token");
      expect(harness.output[0]).not.toContain("private first message");
      const prefix = "Agent started ";
      const audit = JSON.parse(harness.output[0]?.slice(prefix.length) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(harness.output[0]?.startsWith(prefix)).toBe(true);
      expect(audit).toMatchObject({
        time: "1970-01-01T00:00:01.000Z",
        device: { id: device.id, name: "Desk phone", role: "control" },
        run: { kind: "template", name: "review" },
        folder: harness.root,
        placement: "core",
        address: "t-started",
        space: { id: expect.any(String), isNew: true },
        tab: { id: expect.any(String), isNew: true },
      });
    });
  });

  test("requires identity before allowing a WebSocket upgrade", async () => {
    const { handler } = await setup();
    let upgradeData: unknown;
    let upgrades = 0;
    const fakeWebSocketUpgradeTarget: WebSocketUpgradeTarget = {
      upgrade(_request, options) {
        upgrades++;
        upgradeData = options.data;
        return true;
      },
    };

    const denied = await handler(
      request("/ws", { "Tailscale-User-Login": "other" }),
      fakeWebSocketUpgradeTarget,
    );
    expect(denied?.status).toBe(403);
    const deniedMethod = await handler(
      new Request("http://bridge/ws", {
        method: "POST",
        headers: { "Tailscale-User-Login": "other" },
      }),
      fakeWebSocketUpgradeTarget,
    );
    expect(deniedMethod?.status).toBe(403);
    expect(upgrades).toBe(0);

    const upgraded = await handler(request("/ws", ownerHeaders), fakeWebSocketUpgradeTarget);
    expect(upgraded).toBeUndefined();
    expect(upgrades).toBe(1);
    expect(upgradeData).toMatchObject({
      authenticated: false,
      authenticating: false,
      failed: false,
      closed: false,
      counted: false,
    });
  });
});

describe("bridge WebSocket lifecycle", () => {
  test("wires the identity and advertised routes into admin status and pair replies", async () => {
    await withHarness(async (harness) => {
      const adminFetch = harness.serve.admin?.fetch;
      const webFetch = harness.serve.web?.fetch;
      if (!adminFetch || !webFetch)
        throw new Error("fake Bun servers did not receive fetch handlers");

      const statusResponse = await adminFetch(new Request("http://admin/status"));
      const statusText = statusResponse ? await statusResponse.clone().text() : "";
      const status = (await statusResponse?.json()) as {
        bridgeKey: string;
        secure: { port?: number; url?: string };
      };
      expect(status.bridgeKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(status.secure).toEqual({});

      const issuedResponse = await adminFetch(
        new Request("http://admin/pair-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "control", name: "Phone" }),
        }),
      );
      const issued = (await issuedResponse?.json()) as { code: string };
      const pairResponse = await webFetch(
        new Request("http://bridge/api/pair", {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: issued.code }),
        }),
      );
      const pairText = pairResponse ? await pairResponse.clone().text() : "";
      const pair = (await pairResponse?.json()) as {
        bridgeKey: string;
        routes: { direct?: string; secure?: string };
      };

      expect(pair.bridgeKey).toBe(status.bridgeKey);
      expect(pair.routes).toEqual({ direct: "https://mac.tailnet.ts.net" });
      const identity = JSON.parse(
        await readFile(join(harness.root, "state", "identity.json"), "utf8"),
      ) as { secretKey: string };
      expect(statusText).not.toContain(identity.secretKey);
      expect(pairText).not.toContain(identity.secretKey);
      expect(harness.output.join("\n")).not.toContain(identity.secretKey);
    });
  });

  test("starts with mocked Bun servers, authenticates roles, and updates session counts", async () => {
    await withHarness(async (harness) => {
      expect(harness.serve.calls).toHaveLength(2);
      expect(harness.serve.calls[0]?.unix).toBe(harness.bridge.adminSocketPath);
      expect(harness.serve.calls[1]?.hostname).toBe("127.0.0.1");
      expect(harness.serve.calls[1]?.port).toBe(8787);
      expect(await adminStatus(harness)).toEqual({ sessions: 0 });

      const control = await harness.bridge.devices.add({ token: "control-token", role: "control" });
      const watch = await harness.bridge.devices.add({ token: "watch-token", role: "watch" });
      const controlSocket = await authenticate(harness, "control-token");
      const controlChild = harness.runner.children[0];
      expect(controlChild).toBeDefined();
      expect(JSON.parse(String(controlSocket.sent[0]))).toMatchObject({
        ok: true,
        role: control.role,
      });
      expect(harness.clock.pending).toBe(0);
      expect(await adminStatus(harness)).toEqual({ sessions: 1 });

      const callbacks = websocketCallbacks(harness);
      callbacks.message(
        controlSocket,
        line({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } }),
      );
      await settle();
      callbacks.message(
        controlSocket,
        frame({ jsonrpc: "2.0", id: 2, method: "terminal.keys", params: { terminal: "t1" } }),
      );
      await settle();
      expect(controlChild?.core.calls).toEqual(["hello", "terminal.keys"]);

      const watchSocket = await authenticate(harness, "watch-token");
      const watchChild = harness.runner.children[1];
      expect(watchChild).toBeDefined();
      expect(JSON.parse(String(watchSocket.sent[0]))).toMatchObject({
        ok: true,
        role: watch.role,
      });
      expect(await adminStatus(harness)).toEqual({ sessions: 2 });
      callbacks.message(
        watchSocket,
        line({ jsonrpc: "2.0", id: 3, method: "hello", params: { framed: true } }),
      );
      await settle();
      callbacks.message(
        watchSocket,
        frame({ jsonrpc: "2.0", id: 4, method: "terminal.keys", params: { terminal: "t1" } }),
      );
      await settle();
      expect(watchChild?.core.calls).toEqual(["hello"]);

      callbacks.close(controlSocket);
      expect(controlChild?.inputClosed).toBe(true);
      expect(await adminStatus(harness)).toEqual({ sessions: 1 });

      watchChild?.exit(1);
      await settle();
      expect(watchSocket.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.CHILD_EXITED);
      callbacks.close(watchSocket);
      expect(await adminStatus(harness)).toEqual({ sessions: 0 });
    });
  });

  test("rejects malformed, binary, and missing authentication and clears the fake-clock deadline", async () => {
    await withHarness(async (harness) => {
      const callbacks = websocketCallbacks(harness);
      const malformed = await openSocket(harness);
      expect(harness.clock.pending).toBe(1);
      callbacks.message(malformed, "not-json");
      expect(malformed.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(harness.clock.pending).toBe(0);

      const invalidShape = await openSocket(harness);
      callbacks.message(invalidShape, JSON.stringify({ v: 2, token: "control-token" }));
      expect(invalidShape.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(harness.clock.pending).toBe(0);

      const binary = await openSocket(harness);
      callbacks.message(binary, new Uint8Array([0x7b, 0x7d]));
      expect(binary.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(harness.clock.pending).toBe(0);

      const missing = await openSocket(harness);
      expect(harness.clock.pending).toBe(1);
      await harness.clock.advance(WS_AUTH_TIMEOUT_MS);
      expect(missing.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(harness.clock.pending).toBe(0);

      const disconnected = await openSocket(harness);
      expect(harness.clock.pending).toBe(1);
      callbacks.close(disconnected);
      expect(harness.clock.pending).toBe(0);
      await harness.clock.advance(WS_AUTH_TIMEOUT_MS);
      expect(disconnected.closes).toHaveLength(0);
      expect(harness.runner.children).toHaveLength(0);
    });
  });

  test("does not spawn until the device token lookup finishes", async () => {
    await withHarness(async (harness) => {
      const device = await harness.bridge.devices.add({ token: "pending-token", role: "control" });
      let resolveLookup: (value: DeviceRecordView | undefined) => void = () => {};
      const lookup = new Promise<DeviceRecordView | undefined>((resolve) => {
        resolveLookup = resolve;
      });
      harness.bridge.devices.findByToken = () => lookup;

      const socket = await openSocket(harness);
      websocketCallbacks(harness).message(socket, JSON.stringify({ v: 1, token: "pending-token" }));
      await settle();
      expect(harness.runner.children).toHaveLength(0);
      expect(await adminStatus(harness)).toEqual({ sessions: 0 });

      resolveLookup(device);
      await settle();
      expect(harness.runner.argv).toEqual([["/fake/hc", "connect"]]);
      expect(await adminStatus(harness)).toEqual({ sessions: 1 });
    });
  });
});

describe("device revocation closes authenticated sessions", () => {
  async function verifyRevocation(route: "admin" | "api-id" | "api-self"): Promise<void> {
    await withHarness(async (harness) => {
      const targetToken = "target-token";
      const otherToken = "other-token";
      const target = await harness.bridge.devices.add({ token: targetToken, role: "control" });
      await harness.bridge.devices.add({ token: otherToken, role: "control" });
      const first = await authenticate(harness, targetToken);
      const second = await authenticate(harness, targetToken);
      const other = await authenticate(harness, otherToken);
      expect(await adminStatus(harness)).toEqual({ sessions: 3 });

      const callbacks = websocketCallbacks(harness);
      for (const socket of [first, second, other]) {
        callbacks.message(
          socket,
          line({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } }),
        );
      }
      await settle();
      const firstChild = harness.runner.children[0];
      const secondChild = harness.runner.children[1];
      const otherChild = harness.runner.children[2];
      expect(firstChild?.core.calls).toEqual(["hello"]);
      expect(secondChild?.core.calls).toEqual(["hello"]);
      expect(otherChild?.core.calls).toEqual(["hello"]);

      let response: Response | undefined;
      if (route === "admin") {
        const fetch = harness.serve.admin?.fetch;
        if (!fetch) throw new Error("fake Bun server did not receive the admin handler");
        response = await fetch(
          new Request(`http://admin/devices/${encodeURIComponent(target.id)}`, {
            method: "DELETE",
          }),
        );
      } else {
        const fetch = harness.serve.web?.fetch;
        if (!fetch) throw new Error("fake Bun server did not receive the web handler");
        const id = route === "api-self" ? "self" : encodeURIComponent(target.id);
        const callerToken = route === "api-self" ? targetToken : otherToken;
        response = await fetch(
          new Request(`http://bridge/api/devices/${id}`, {
            method: "DELETE",
            headers: {
              ...ownerHeaders,
              Authorization: `Bearer ${callerToken}`,
            },
          }),
          harness.upgradeServer,
        );
      }

      expect(response?.status).toBe(204);
      expect(first.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(second.closes[0]?.code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(other.closes).toHaveLength(0);
      expect(firstChild?.inputClosed).toBe(true);
      expect(secondChild?.inputClosed).toBe(true);
      expect(await adminStatus(harness)).toEqual({ sessions: 1 });

      callbacks.message(
        first,
        frame({ jsonrpc: "2.0", id: 2, method: "terminal.keys", params: { terminal: "t1" } }),
      );
      callbacks.message(
        second,
        frame({ jsonrpc: "2.0", id: 3, method: "terminal.keys", params: { terminal: "t1" } }),
      );
      callbacks.message(
        other,
        frame({ jsonrpc: "2.0", id: 4, method: "terminal.keys", params: { terminal: "t1" } }),
      );
      await settle();
      expect(firstChild?.core.calls).toEqual(["hello"]);
      expect(secondChild?.core.calls).toEqual(["hello"]);
      expect(otherChild?.core.calls).toEqual(["hello", "terminal.keys"]);
    });
  }

  test("admin DELETE closes every session for the revoked device", async () => {
    await verifyRevocation("admin");
  });

  test("DELETE /api/devices/:id closes every session for the revoked device", async () => {
    await verifyRevocation("api-id");
  });

  test("DELETE /api/devices/self closes every session for the caller device", async () => {
    await verifyRevocation("api-self");
  });
});

describe("bridge startup failures", () => {
  test("a corrupt devices file raises DeviceFileError and makes the CLI exit non-zero", async () => {
    const scratch = join(process.cwd(), ".unshit");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "corrupt-devices-u4-"));
    const stateHome = join(root, "xdg-state");
    const stateDir = join(stateHome, "herdr-bridge");
    const deviceFilePath = join(stateDir, "devices.json");
    const serve = fakeServe();
    const clock = new FakeClock();
    const runner = new FakeBridgeRunner();
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(deviceFilePath, "{broken json");
      const config: BridgeConfig = {
        ownerLogin: "owner@example.com",
        host: "127.0.0.1",
        port: 8787,
        publicUrl: "https://mac.tailnet.ts.net",
        webDir: join(root, "web"),
        hcPath: "/fake/hc",
        herdrAppPath: "/fake/herdr-app",
        programs: ["claude", "codex"],
        roots: [root],
        home: root,
        whois: false,
        stateDir,
        deviceFilePath,
        adminSocketPath: join(stateDir, "admin.sock"),
        machine: { id: "mac-1", name: "Mac" },
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        cwd: root,
      };

      let openError: unknown;
      try {
        await serveBridge(config, { clock, runner });
      } catch (error) {
        openError = error;
      }
      expect(openError).toBeInstanceOf(DeviceFileError);
      expect((openError as DeviceFileError).path).toBe(deviceFilePath);
      expect(serve.calls).toHaveLength(0);

      const errors: string[] = [];
      const exitCode = await runCli(
        [
          "serve",
          "--owner",
          "owner@example.com",
          "--public-url",
          "https://mac.tailnet.ts.net",
          "--web",
          join(root, "web"),
          "--hc",
          "/fake/hc",
          "--herdr-app",
          "/fake/herdr-app",
        ],
        {
          env: { HOME: root, XDG_STATE_HOME: stateHome, PATH: "/usr/bin:/bin" },
          cwd: root,
          clock,
          runner,
          stderr: (message) => errors.push(message),
        },
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain(deviceFilePath);
      expect(serve.calls).toHaveLength(0);
    } finally {
      serve.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
