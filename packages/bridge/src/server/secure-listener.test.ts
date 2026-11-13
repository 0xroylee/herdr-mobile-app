import { describe, expect, spyOn, test } from "bun:test";
import { BRIDGE_WS_CLOSE_CODES } from "@herdr-mobile/protocol";
import {
  type DuplexSocket,
  generateStaticKeyPair,
  openInitiator,
  type SecureSession,
  type StaticKeyPair,
} from "@herdr-mobile/secure-channel";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import type { AppCliContext } from "./app-cli.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
import type { IdentityKeyStore } from "./identity-key.ts";
import { PairingCodes } from "./pairing.ts";
import type { ApiContext } from "./routes.ts";
import type { SecureListenerDependencies } from "./secure-listener.ts";
import { MAX_HANDSHAKES_IN_PROGRESS, startSecureListener } from "./secure-listener.ts";
import { AgentStarter } from "./start-agent.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MACHINE = { id: "machine-1", name: "Mac" };
const ROUTES = {
  direct: "https://mac.tailnet.ts.net",
  secure: "https://bridge.example.test",
};
const BRIDGE_KEY = "a".repeat(43);

class MapFs implements StoreFs {
  readonly files = new Map<string, string>();
  failWrites = false;
  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async mkdir(): Promise<void> {}
  async writeFile(path: string, contents: string): Promise<void> {
    if (this.failWrites) throw new Error("injected write failure");
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

class FakeClock implements Clock {
  current = 1_800_000_000_000;
  private nextId = 1;
  private readonly timers: Array<{ id: number; at: number; callback: () => void }> = [];

  now(): number {
    return this.current;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + ms, callback });
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

class FakeIdentity implements IdentityKeyStore {
  key: StaticKeyPair = generateStaticKeyPair();
  private readonly listeners = new Set<(keyPair: StaticKeyPair) => void>();

  current(): StaticKeyPair {
    return { publicKey: this.key.publicKey.slice(), secretKey: this.key.secretKey.slice() };
  }
  async rotate(): Promise<StaticKeyPair> {
    this.key.secretKey.fill(0);
    this.key = generateStaticKeyPair();
    const next = this.current();
    for (const listener of this.listeners) listener(this.current());
    return next;
  }
  onRotate(listener: (keyPair: StaticKeyPair) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FakeConnect implements OwnedProcess {
  readonly writes: Uint8Array[] = [];
  readonly exited: Promise<number | null>;
  inputClosed = false;
  private onData: ((bytes: Uint8Array) => void) | undefined;
  private onEnd: (() => void) | undefined;
  private resolveExit: (code: number | null) => void = () => {};

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice());
    this.onData?.(bytes.slice());
  }
  closeInput(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.onEnd?.();
    this.resolveExit(0);
  }
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    this.onData = onData;
    this.onEnd = onEnd;
  }
  kill(): void {
    this.onEnd?.();
    this.resolveExit(null);
  }
}

class FakeCommand implements OwnedProcess {
  readonly exited = Promise.resolve(1);
  write(): void {}
  closeInput(): void {}
  read(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {}
}

class FakeRunner implements ProcessRunner {
  readonly children: FakeConnect[] = [];
  spawn(argv: string[]): OwnedProcess {
    if (argv[0] === "/fake/herdr-app") return new FakeCommand();
    const child = new FakeConnect();
    this.children.push(child);
    return child;
  }
}

interface Fixture {
  fs: MapFs;
  identity: FakeIdentity;
  clock: FakeClock;
  devices: DeviceStore;
  pairing: PairingCodes;
  runner: FakeRunner;
  logs: string[];
  dependencies: SecureListenerDependencies;
}

async function fixture(): Promise<Fixture> {
  const clock = new FakeClock();
  const fs = new MapFs();
  const devices = await DeviceStore.open(fs, "/state/devices.json", clock);
  const pairing = new PairingCodes(clock);
  const identity = new FakeIdentity();
  const runner = new FakeRunner();
  const logs: string[] = [];
  const api: ApiContext = {
    devices,
    pairing,
    machine: MACHINE,
    routes: () => ROUTES,
    bridgeKey: () => BRIDGE_KEY,
    authorizePairing: async () => false,
  };
  const appCli: AppCliContext = {
    runner,
    env: { HOME: "/home/owner" },
    cwd: "/repo",
    herdrAppPath: "/fake/herdr-app",
    clock,
  };
  const agentStarter = new AgentStarter({
    runner,
    programs: ["claude", "codex"],
    roots: ["/home/owner"],
    home: "/home/owner",
    herdrAppPath: appCli.herdrAppPath,
    hcPath: "/fake/hc",
    env: appCli.env,
    cwd: appCli.cwd,
    clock,
    statFs: {
      async realPath(path) {
        return path;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    },
    coreCall: async (method) => (method === "templates.list" ? { templates: [] } : {}),
  });
  const dependencies: SecureListenerDependencies = {
    identity,
    devices,
    pairing,
    machine: MACHINE,
    routes: () => ROUTES,
    bridgeKey: () => BRIDGE_KEY,
    dispatch: { api, appCli, agentStarter },
    runner,
    env: appCli.env,
    hc: "/fake/hc",
    clock,
    stdout: (line) => logs.push(line),
  };
  return { fs, identity, clock, devices, pairing, runner, logs, dependencies };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index++) {
    await settle();
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

interface ConnectedClient {
  socket: DuplexSocket;
  session: SecureSession;
  records: Array<{ kind: "text" | "binary"; bytes: Uint8Array }>;
}

function textRecords(client: ConnectedClient): unknown[] {
  return client.records
    .filter((record) => record.kind === "text")
    .map((record) => JSON.parse(decoder.decode(record.bytes)) as unknown);
}

describe("secure bridge listener", () => {
  async function verifyChannelSelfRevoke(
    method: string,
    options: { failPersistence?: boolean } = {},
  ): Promise<void> {
    const setup = await fixture();
    const device = await setup.devices.add({ token: "self-revoke-token", role: "control" });
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      setup.dependencies.onDeviceRevocation = () => {
        listener.closeRevokedSessions(new Set(setup.devices.list().map((entry) => entry.id)));
      };
      const client = await connect({ v: 1, token: "self-revoke-token" });
      await waitUntil(() => textRecords(client).length === 1);

      if (options.failPersistence) setup.fs.failWrites = true;
      client.session.send(
        "text",
        encoder.encode(JSON.stringify({ t: "req", id: 9, method, path: "/api/devices/self" })),
      );
      await waitUntil(() => textRecords(client).length === 2);

      expect(textRecords(client)[1]).toMatchObject({
        t: "res",
        id: 9,
        status: options.failPersistence ? 500 : 204,
      });
      expect((await client.session.closed).code).toBe(BRIDGE_WS_CLOSE_CODES.BAD_TOKEN);
      expect(setup.devices.list().some((entry) => entry.id === device.id)).toBe(false);

      const responseCount = textRecords(client).length;
      try {
        client.session.send(
          "text",
          encoder.encode(JSON.stringify({ t: "req", id: 10, method: "GET", path: "/api/health" })),
        );
      } catch {
        // The closed secure channel may reject sends synchronously.
      }
      await settle();
      expect(textRecords(client)).toHaveLength(responseCount);
    });
  }

  test("authenticates a real Noise initiator, replies with routes and key, and forwards binary bytes", async () => {
    const setup = await fixture();
    const device = await setup.devices.add({ token: "control-token", role: "control" });
    await withCapturedSecureListener(setup, async ({ listener, connect }) => {
      const client = await connect({ v: 1, token: "control-token" });
      await waitUntil(() => textRecords(client).length === 1);

      expect(textRecords(client)[0]).toEqual({
        v: 1,
        ok: true,
        role: "control",
        machine: MACHINE,
        routes: ROUTES,
        bridgeKey: BRIDGE_KEY,
      });
      expect(listener.sessions).toBe(1);
      expect(setup.runner.children).toHaveLength(1);

      const bytes = encoder.encode('{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}\n');
      client.session.send("binary", bytes);
      await waitUntil(() => setup.runner.children[0]?.writes.length === 1);
      await waitUntil(() => client.records.some((record) => record.kind === "binary"));
      expect(setup.runner.children[0]?.writes[0]).toEqual(bytes);
      expect(client.records.find((record) => record.kind === "binary")?.bytes).toEqual(bytes);

      client.session.close(1000, "test complete");
      await waitUntil(() => listener.sessions === 0);
      expect(setup.logs.some((line) => line.startsWith("Secure session opened "))).toBe(true);
      expect(setup.logs.join("\n")).not.toContain("control-token");
      expect(device.role).toBe("control");
    });
  });

  test("pairs on the secure channel and returns a usable PairReply", async () => {
    const setup = await fixture();
    const issued = setup.pairing.issue("control", "Phone");
    await withCapturedSecureListener(setup, async ({ connect }) => {
      const client = await connect({ v: 1, pair: { code: issued.code, name: "New phone" } });
      await waitUntil(() => textRecords(client).length === 1);
      const reply = textRecords(client)[0] as {
        deviceId: string;
        token: string;
        role: string;
        routes: typeof ROUTES;
        bridgeKey: string;
      };
      expect(reply).toMatchObject({
        role: "control",
        routes: ROUTES,
        bridgeKey: BRIDGE_KEY,
      });
      expect(await setup.devices.findByToken(reply.token)).toMatchObject({
        id: reply.deviceId,
        name: "New phone",
        role: "control",
      });
      client.session.close(1000, "test complete");
    });
  });

  test("rejects a wrong token with 4401 and a bad pair code with 4402", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const wrongToken = await connect({ v: 1, token: "wrong" });
      const wrongTokenClose = await wrongToken.session.closed;
      expect(wrongTokenClose.code).toBe(4401);

      const badCode = await connect({ v: 1, pair: { code: "ABCDEFGH" } });
      const badCodeClose = await badCode.session.closed;
      expect(badCodeClose.code).toBe(4402);
      expect(listener.handshakeFailuresLastHour).toBe(2);
    });
  });

  test("caps the first clear authentication record at 1,024 UTF-8 bytes", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const client = await connect({ v: 1, token: "x".repeat(1_024) });
      expect((await client.session.closed).code).toBe(4401);
      expect(listener.handshakeFailuresLastHour).toBe(1);
    });
  });

  test("closes an incomplete Noise handshake on text, wrong length, or the deadline", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ openSocket }) => {
      const text = await openSocket();
      text.socket.sendMessage("not binary");
      expect(text.socket.closeEvent?.code).toBe(1002);

      const short = await openSocket();
      short.socket.sendMessage(new Uint8Array(48));
      expect(short.socket.closeEvent?.code).toBe(1002);

      const timeout = await openSocket();
      const timeoutSession = await openInitiator(timeout.duplex, {
        remoteStaticKey: setup.identity.key.publicKey,
      });
      let timeoutClose = 0;
      timeoutSession.closed.then(({ code }) => {
        timeoutClose = code;
      });
      await setup.clock.advance(10_000);
      expect(timeoutClose).toBe(4401);
    });
  });

  test("limits simultaneous handshakes to 64 and closes the next one with 1013", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ openSocket, listener }) => {
      const peers: FakeBunSocket[] = [];
      for (let index = 0; index < MAX_HANDSHAKES_IN_PROGRESS; index++) {
        peers.push((await openSocket()).socket);
      }
      const rejected = await openSocket();
      expect(rejected.socket.closeEvent?.code).toBe(1013);
      expect(listener.handshakeFailuresLastHour).toBe(1);
      for (const peer of peers) peer.close(1000, "test cleanup");
    });
  });

  test("rejects the wrong responder key as 4003 and counts the key mismatch", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ openSocket, listener }) => {
      const { duplex } = await openSocket();
      const wrongKey = generateStaticKeyPair();
      await expect(
        openInitiator(duplex, { remoteStaticKey: wrongKey.publicKey }),
      ).rejects.toMatchObject({
        name: "KeyMismatchError",
        closeCode: 4003,
      });
      expect(listener.handshakeFailuresLastHour).toBe(1);
      expect(setup.logs.join("\n")).toContain('"reason":"key_mismatch"');
    });
  });

  test("dispatches channel API requests with the bound role and rejects pairing or non-API paths", async () => {
    const setup = await fixture();
    const control = await setup.devices.add({ token: "control-token", role: "control" });
    await setup.devices.add({ token: "watch-token", role: "watch" });
    await withCapturedSecureListener(setup, async ({ connect }) => {
      const controlClient = await connect({ v: 1, token: "control-token" });
      await waitUntil(() => textRecords(controlClient).length === 1);
      controlClient.session.send(
        "text",
        encoder.encode(
          JSON.stringify({ t: "req", id: 1, method: "GET", path: "/api/agents/catalog" }),
        ),
      );
      await waitUntil(() => textRecords(controlClient).length === 2);
      const catalogResponse = textRecords(controlClient)[1] as {
        t: string;
        id: number;
        status: number;
        body: string;
      };
      expect(catalogResponse).toMatchObject({ t: "res", id: 1, status: 200 });
      expect(JSON.parse(catalogResponse.body)).toMatchObject({ programs: ["claude", "codex"] });

      const watchClient = await connect({ v: 1, token: "watch-token" });
      await waitUntil(() => textRecords(watchClient).length === 1);
      watchClient.session.send(
        "text",
        encoder.encode(
          JSON.stringify({ t: "req", id: 2, method: "GET", path: "/api/agents/catalog" }),
        ),
      );
      await waitUntil(() => textRecords(watchClient).length === 2);
      expect(textRecords(watchClient)[1]).toMatchObject({ t: "res", id: 2, status: 403 });

      watchClient.session.send(
        "text",
        encoder.encode(JSON.stringify({ t: "req", id: 3, method: "POST", path: "/api/pair" })),
      );
      watchClient.session.send(
        "text",
        encoder.encode(JSON.stringify({ t: "req", id: 4, method: "GET", path: "/not-api" })),
      );
      await waitUntil(() => textRecords(watchClient).length === 4);
      expect(textRecords(watchClient).slice(2)).toEqual([
        { t: "res", id: 3, status: 404, body: JSON.stringify({ error: "not_found" }) },
        { t: "res", id: 4, status: 404, body: JSON.stringify({ error: "not_found" }) },
      ]);

      expect(await setup.devices.findByToken("control-token")).toMatchObject({ id: control.id });
      controlClient.session.close(1000, "test complete");
      watchClient.session.close(1000, "test complete");
    });
  });

  test("closes a revoked secure device with 4401", async () => {
    const setup = await fixture();
    await setup.devices.add({ token: "control-token", role: "control" });
    await withCapturedSecureListener(setup, async ({ listener, connect }) => {
      const client = await connect({ v: 1, token: "control-token" });
      await waitUntil(() => listener.sessions === 1);
      listener.closeRevokedSessions(new Set());
      expect((await client.session.closed).code).toBe(4401);
      expect(listener.sessions).toBe(0);
    });
  });

  test("lowercase self-revoke closes the channel after its response", async () => {
    await verifyChannelSelfRevoke("delete");
  });

  test("mixed-case self-revoke closes the channel after its response", async () => {
    await verifyChannelSelfRevoke("dElEtE");
  });

  test("self-revoke persistence failure still closes the channel and removes its access", async () => {
    await verifyChannelSelfRevoke("DELETE", { failPersistence: true });
  });

  test("counts and logs binary and malformed protected first records once without record contents", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const binary = await connect();
      binary.session.send("binary", encoder.encode("secret-record-content"));
      expect((await binary.session.closed).code).toBe(BRIDGE_WS_CLOSE_CODES.RECORD_PROTOCOL);

      const malformed = await connect();
      malformed.bunSocket.sendMessage(new Uint8Array([0]));
      await waitUntil(() => malformed.bunSocket.closeEvent !== undefined);

      expect(listener.handshakeFailuresLastHour).toBe(2);
      const failures = setup.logs.filter((line) => line.startsWith("Secure handshake failed "));
      expect(failures).toHaveLength(2);
      expect(failures.every((line) => line.includes('"reason":"protocol"'))).toBe(true);
      expect(failures.join("\n")).not.toContain("secret-record-content");
      expect(setup.runner.children).toHaveLength(0);
    });
  });
});

describe("secure listener HTTP surface", () => {
  test("binds to loopback port 0 and returns 404 except GET /ws, ignoring Tailscale headers", async () => {
    const setup = await fixture();
    const bun = fakeBunServe();
    try {
      const listener = await startSecureListener({ port: 0 }, setup.dependencies);
      const options = bun.options;
      if (!options?.fetch) throw new Error("Bun.serve did not receive a fetch handler");
      expect(options.hostname).toBe("127.0.0.1");
      expect(options.port).toBe(0);
      expect(listener.port).toBe(0);
      const fetch = options.fetch;
      const server = { upgrade: () => true };
      const responses = await Promise.all([
        fetch(new Request("http://bridge/api/health"), server),
        fetch(
          new Request("http://bridge/api/health", {
            headers: { "Tailscale-User-Login": "owner@example.com" },
          }),
          server,
        ),
        fetch(new Request("http://bridge/"), server),
        fetch(new Request("http://bridge/ws", { method: "POST" }), server),
      ]);
      expect(responses.map((response) => response?.status)).toEqual([404, 404, 404, 404]);
      listener.stop();
    } finally {
      bun.restore();
    }
  });

  test("identity rotation closes a connection before its first Noise message", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ upgradeSocket, listener }) => {
      const connection = await upgradeSocket();
      await setup.identity.rotate();
      connection.open();

      expect(connection.socket.closeEvent?.code).toBe(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED);
      expect(listener.sessions).toBe(0);
      expect(setup.runner.children).toHaveLength(0);
    });
  });

  test("identity rotation closes a split secure channel before authentication", async () => {
    const setup = await fixture();
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const client = await connect();
      await setup.identity.rotate();

      expect((await client.session.closed).code).toBe(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED);
      expect(listener.sessions).toBe(0);
      expect(setup.runner.children).toHaveLength(0);
    });
  });

  test("identity rotation prevents a pending token lookup from activating a session", async () => {
    const setup = await fixture();
    const device = await setup.devices.add({ token: "pending-token", role: "control" });
    let resolveLookup: (value: typeof device | undefined) => void = () => {};
    const lookup = new Promise<typeof device | undefined>((resolve) => {
      resolveLookup = resolve;
    });
    setup.devices.findByToken = () => lookup;

    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const client = await connect({ v: 1, token: "pending-token" });
      await settle();
      expect(setup.runner.children).toHaveLength(0);

      await setup.identity.rotate();
      resolveLookup(device);
      await settle();

      expect((await client.session.closed).code).toBe(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED);
      expect(listener.sessions).toBe(0);
      expect(setup.runner.children).toHaveLength(0);
      expect(textRecords(client)).toHaveLength(0);
    });
  });

  test("identity rotation closes an authenticated secure session with 1012", async () => {
    const setup = await fixture();
    await setup.devices.add({ token: "control-token", role: "control" });
    await withCapturedSecureListener(setup, async ({ connect, listener }) => {
      const client = await connect({ v: 1, token: "control-token" });
      await waitUntil(() => textRecords(client).length === 1 && listener.sessions === 1);
      await setup.identity.rotate();
      expect((await client.session.closed).code).toBe(BRIDGE_WS_CLOSE_CODES.IDENTITY_ROTATED);
      expect(listener.sessions).toBe(0);
    });
  });
});

interface FakeBunWebSocketCallbacks {
  open(socket: unknown): void;
  message(socket: unknown, message: string | Uint8Array): void;
  close(socket: unknown, code: number, reason: string): void;
}

interface FakeBunServeOptions {
  hostname?: string;
  port?: number;
  fetch?: (
    request: Request,
    server: { upgrade(request: Request, options: { data: unknown }): boolean },
  ) => Promise<Response | undefined> | Response | undefined;
  websocket?: FakeBunWebSocketCallbacks;
}

function fakeBunServe(): { options?: FakeBunServeOptions; restore(): void } {
  const captured: { options?: FakeBunServeOptions; restore(): void } = {
    restore() {},
  };
  const spy = spyOn(Bun, "serve").mockImplementation((unknownOptions) => {
    captured.options = unknownOptions as FakeBunServeOptions;
    return { port: captured.options.port ?? 0, stop() {} } as ReturnType<typeof Bun.serve>;
  });
  captured.restore = () => spy.mockRestore();
  return captured;
}

class FakeUpgradeServer {
  socket: FakeBunSocket | undefined;
  private readonly callbacks: FakeBunWebSocketCallbacks;
  constructor(callbacks: FakeBunWebSocketCallbacks) {
    this.callbacks = callbacks;
  }
  upgrade(_request: Request, options: { data: unknown }): boolean {
    this.socket = new FakeBunSocket(options.data, this.callbacks);
    return true;
  }
}

class FakeBunSocket {
  readonly clientMessages: Array<(bytes: Uint8Array) => void> = [];
  readonly clientCloses: Array<(code: number, reason: string) => void> = [];
  readonly data: unknown;
  closeEvent: { code: number; reason: string } | undefined;
  private didClose = false;
  private readonly callbacks: FakeBunWebSocketCallbacks;

  constructor(data: unknown, callbacks: FakeBunWebSocketCallbacks) {
    this.data = data;
    this.callbacks = callbacks;
  }

  send(bytes: Uint8Array): void {
    if (this.didClose) return;
    for (const listener of [...this.clientMessages]) listener(bytes.slice());
  }
  close(code: number, reason: string): void {
    if (this.didClose) return;
    this.didClose = true;
    this.closeEvent = { code, reason };
    this.callbacks.close(this.asServerSocket(), code, reason);
    for (const listener of [...this.clientCloses]) listener(code, reason);
  }
  sendMessage(message: string | Uint8Array): void {
    if (this.didClose) return;
    this.callbacks.message(this.asServerSocket(), message);
  }
  asServerSocket(): never {
    return this as never;
  }
  asClientDuplex(): DuplexSocket {
    return {
      send: (bytes) => this.callbacks.message(this.asServerSocket(), bytes),
      close: (code, reason) => this.close(code, reason),
      onMessage: (listener) => this.clientMessages.push(listener),
      onClose: (listener) => this.clientCloses.push(listener),
    };
  }
}

interface CapturedSecureListener {
  listener: Awaited<ReturnType<typeof startSecureListener>>;
  upgradeSocket(): Promise<{ socket: FakeBunSocket; duplex: DuplexSocket; open(): void }>;
  openSocket(): Promise<{ socket: FakeBunSocket; duplex: DuplexSocket }>;
  connect(firstMessage?: unknown): Promise<ConnectedClient & { bunSocket: FakeBunSocket }>;
}

async function withCapturedSecureListener<T>(
  setup: Fixture,
  run: (harness: CapturedSecureListener) => Promise<T>,
): Promise<T> {
  const bun = fakeBunServe();
  let listener: Awaited<ReturnType<typeof startSecureListener>> | undefined;
  try {
    listener = await startSecureListener({ port: 0 }, setup.dependencies);
    const options = bun.options;
    const fetch = options?.fetch;
    const websocket = options?.websocket;
    if (!fetch || !websocket) {
      throw new Error("Bun.serve did not receive secure WebSocket handlers");
    }

    const upgradeSocket = async () => {
      const upgrade = new FakeUpgradeServer(websocket);
      const response = await fetch(new Request("http://bridge/ws"), upgrade);
      if (response) throw new Error(`secure WebSocket upgrade failed with ${response.status}`);
      const socket = upgrade.socket;
      if (!socket) throw new Error("secure listener did not upgrade the WebSocket");
      let opened = false;
      return {
        socket,
        duplex: socket.asClientDuplex(),
        open() {
          if (opened) return;
          opened = true;
          websocket.open(socket.asServerSocket());
        },
      };
    };

    const openSocket = async () => {
      const connection = await upgradeSocket();
      connection.open();
      return { socket: connection.socket, duplex: connection.duplex };
    };

    const connect = async (firstMessage?: unknown) => {
      const { socket, duplex } = await openSocket();
      const session = await openInitiator(duplex, {
        remoteStaticKey: setup.identity.key.publicKey,
      });
      const records: ConnectedClient["records"] = [];
      session.onRecord((kind, bytes) => records.push({ kind, bytes }));
      if (firstMessage !== undefined) {
        session.send("text", encoder.encode(JSON.stringify(firstMessage)));
      }
      return { socket: duplex, session, records, bunSocket: socket };
    };

    return await run({ listener, upgradeSocket, openSocket, connect });
  } finally {
    listener?.stop();
    bun.restore();
  }
}
