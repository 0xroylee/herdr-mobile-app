/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import {
  createMemoryDuplexPair,
  type DuplexSocket,
  encodeBase64Url,
  generateStaticKeyPair,
  HandshakeError,
  KeyMismatchError,
  openResponder,
  type SecureSession,
  type StaticKeyPair,
} from "@herdr-mobile/secure-channel";
import { createChannelFetch } from "./channel-fetch.ts";
import { secureSocket } from "./secure-socket.ts";

describe("secure socket", () => {
  test("passes auth and core messages while hiding channel API records", async () => {
    await withMemoryWebSocket(async (identity) => {
      MemoryWebSocket.onServerSession = (session) => {
        session.onRecord((kind, data) => {
          if (kind === "binary") {
            session.send("binary", data);
            return;
          }
          const text = utf8Decode(data);
          const value = JSON.parse(text) as { t?: string; id?: number; token?: string };
          if (value.t === "req") {
            session.send(
              "text",
              utf8Encode(
                JSON.stringify({ t: "res", id: value.id, status: 200, body: '{"ok":true}' }),
              ),
            );
            return;
          }
          session.send(
            "text",
            utf8Encode(
              JSON.stringify({
                v: 1,
                ok: true,
                role: "control",
                machine: { id: "mac-1", name: "Mac" },
              }),
            ),
          );
        });
      };

      const socket = secureSocket({
        url: "https://bridge.example.test",
        key: encodeBase64Url(identity.publicKey),
      });
      const messages: unknown[] = [];
      socket.onmessage = (value) => messages.push(value);
      socket.onopen = () => socket.send(JSON.stringify({ v: 1, token: "device-token" }));

      await waitFor(() => messages.length === 1);
      expect(messages[0]).toBe(
        JSON.stringify({
          v: 1,
          ok: true,
          role: "control",
          machine: { id: "mac-1", name: "Mac" },
        }),
      );

      socket.send(new Uint8Array([1, 2, 3]));
      await waitFor(() => messages.length === 2);
      expect([...new Uint8Array(messages[1] as ArrayBuffer)]).toEqual([1, 2, 3]);

      const fetch = createChannelFetch(socket.session, "Mac");
      const response = await fetch("https://bridge.example.test/api/health");
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(messages).toHaveLength(2);
      socket.close(1000, "test complete");
    });
  });

  test("a wrong pinned responder key rejects with KeyMismatchError and close 4003", async () => {
    await withMemoryWebSocket(async () => {
      const wrongIdentity = generateStaticKeyPair();
      const socket = secureSocket({
        url: "https://bridge.example.test",
        key: encodeBase64Url(wrongIdentity.publicKey),
      });
      let closeCode: number | undefined;
      socket.onclose = (event) => (closeCode = event.code);

      await expect(socket.session).rejects.toBeInstanceOf(KeyMismatchError);
      expect(closeCode).toBe(4003);
      await waitFor(() => MemoryWebSocket.instances[0]?.closed === true);
      expect(MemoryWebSocket.instances[0]?.closeEvents).toEqual([
        { code: 4003, reason: "bridge key mismatch" },
      ]);
    });
  });

  test("a handshake protocol failure closes the platform socket with 1000 and reports 1002", async () => {
    await withMemoryWebSocket(async (identity) => {
      MemoryWebSocket.injectInvalidHandshakeFrame = true;
      const socket = secureSocket({
        url: "https://bridge.example.test",
        key: encodeBase64Url(identity.publicKey),
      });
      let closeCode: number | undefined;
      socket.onclose = (event) => (closeCode = event.code);

      await expect(socket.session).rejects.toBeInstanceOf(HandshakeError);
      expect(closeCode).toBe(1002);
      expect(MemoryWebSocket.instances[0]?.closeRequests).toEqual([
        { code: 1000, reason: "protocol error" },
      ]);
      expect(MemoryWebSocket.instances[0]?.closed).toBe(true);
    });
  });

  test("a protected-record failure closes the platform socket with 1000 and reports 1008", async () => {
    await withMemoryWebSocket(async (identity) => {
      const socket = secureSocket({
        url: "https://bridge.example.test",
        key: encodeBase64Url(identity.publicKey),
      });
      let closeCode: number | undefined;
      socket.onclose = (event) => (closeCode = event.code);
      const session = await socket.session;
      MemoryWebSocket.instances[0]?.serverDuplex.send(new Uint8Array([0]));

      await waitFor(() => closeCode !== undefined);
      await expect(session.closed).resolves.toMatchObject({ code: 1008 });
      expect(closeCode).toBe(1008);
      expect(MemoryWebSocket.instances[0]?.closeRequests).toEqual([
        { code: 1000, reason: "protocol error" },
      ]);
      expect(MemoryWebSocket.instances[0]?.closed).toBe(true);
    });
  });
});

let webSocketTask = Promise.resolve();

async function withMemoryWebSocket<T>(action: (identity: StaticKeyPair) => Promise<T>): Promise<T> {
  const previous = webSocketTask;
  let release!: () => void;
  webSocketTask = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const host = globalThis as unknown as { WebSocket: typeof WebSocket };
  const original = host.WebSocket;
  const identity = generateStaticKeyPair();
  MemoryWebSocket.identity = identity;
  MemoryWebSocket.onServerSession = undefined;
  MemoryWebSocket.injectInvalidHandshakeFrame = false;
  MemoryWebSocket.instances = [];
  host.WebSocket = MemoryWebSocket as unknown as typeof WebSocket;
  try {
    return await action(identity);
  } finally {
    MemoryWebSocket.onServerSession = undefined;
    MemoryWebSocket.injectInvalidHandshakeFrame = false;
    MemoryWebSocket.instances = [];
    host.WebSocket = original;
    release();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

class MemoryWebSocket {
  static identity: StaticKeyPair;
  static onServerSession: ((session: SecureSession, socket: DuplexSocket) => void) | undefined;
  static injectInvalidHandshakeFrame = false;
  static instances: MemoryWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  binaryType: BinaryType = "arraybuffer";
  readonly url: string;
  readonly clientDuplex;
  readonly serverDuplex: DuplexSocket;
  readonly closeRequests: { code: number; reason: string }[] = [];
  readonly closeEvents: { code: number; reason: string }[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    const [client, server] = createMemoryDuplexPair();
    this.clientDuplex = client;
    this.serverDuplex = server;
    MemoryWebSocket.instances.push(this);
    client.onMessage((bytes) => {
      const data = bytes.slice().buffer as ArrayBuffer;
      this.onmessage?.({ data } as MessageEvent);
    });
    client.onClose((code, reason) => {
      this.closed = true;
      this.closeEvents.push({ code, reason });
      this.onclose?.({ code, reason } as CloseEvent);
    });
    if (!MemoryWebSocket.injectInvalidHandshakeFrame) {
      void openResponder(server, { localStatic: MemoryWebSocket.identity }).then(
        (session) => MemoryWebSocket.onServerSession?.(session, server),
        () => {},
      );
    }
    queueMicrotask(() => {
      this.onopen?.({} as Event);
      if (MemoryWebSocket.injectInvalidHandshakeFrame) server.send(new Uint8Array([0]));
    });
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") throw new Error("only binary frames are supported");
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.clientDuplex.send(bytes);
  }

  close(code = 1000, reason = "closed"): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`Browser rejected WebSocket close code ${code}`);
    }
    this.closeRequests.push({ code, reason });
    this.closed = true;
    this.clientDuplex.close(code, reason);
  }
}
