/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import {
  createMemoryDuplexPair,
  generateStaticKeyPair,
  openInitiator,
  openResponder,
} from "@herdr-mobile/secure-channel";
import { createChannelFetch } from "./channel-fetch.ts";
import type { Clock } from "./connection.ts";

describe("channel fetch", () => {
  test("round-trips a Bridge API request through req and res records", async () => {
    const { client, server } = await makeSessions();
    let requestValue: unknown;
    server.onRecord((kind, bytes) => {
      if (kind !== "text") return;
      const request: unknown = JSON.parse(utf8Decode(bytes));
      requestValue = request;
      const id = (request as { id: number }).id;
      server.send(
        "text",
        utf8Encode(
          JSON.stringify({ t: "res", id, status: 200, body: JSON.stringify({ ok: true }) }),
        ),
      );
    });
    const fetch = createChannelFetch(client, "MacBook Pro", new FakeClock());

    const response = await fetch("https://edge.example.test/api/health?full=1", {
      method: "GET",
      headers: { Authorization: "Bearer must-not-cross-the-channel" },
    });

    expect(requestValue).toEqual({
      t: "req",
      id: 1,
      method: "GET",
      path: "/api/health?full=1",
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
    client.close(1000, "test complete");
  });

  test("times out an unanswered channel request", async () => {
    const { client, server } = await makeSessions();
    server.onRecord(() => {});
    const clock = new FakeClock();
    const fetch = createChannelFetch(client, "Mac", clock);
    const pending = fetch("https://edge.example.test/api/health");
    let settled = false;
    void pending.finally(() => (settled = true)).catch(() => {});
    await flush();
    clock.advance(19_999);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);

    await expect(pending).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 504,
      code: "request_timeout",
      message: "Request to Mac timed out.",
    });
    client.close(1000, "test complete");
  });

  test("rejects a malformed response instead of leaving its request pending", async () => {
    const { client, server } = await makeSessions();
    server.onRecord((kind, bytes) => {
      if (kind !== "text") return;
      const request = JSON.parse(utf8Decode(bytes)) as { id: number };
      server.send("text", utf8Encode(JSON.stringify({ t: "res", id: request.id, status: 42 })));
    });
    const fetch = createChannelFetch(client, "Mac", new FakeClock());

    await expect(fetch("https://edge.example.test/api/health")).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 502,
      code: "bad_response",
      message: "The bridge returned an invalid response.",
    });
    server.close(1000, "test complete");
  });

  test("rejects a response whose body is not a string", async () => {
    const { client, server } = await makeSessions();
    server.onRecord((kind, bytes) => {
      if (kind !== "text") return;
      const request = JSON.parse(utf8Decode(bytes)) as { id: number };
      server.send(
        "text",
        utf8Encode(JSON.stringify({ t: "res", id: request.id, status: 200, body: { ok: true } })),
      );
    });
    const fetch = createChannelFetch(client, "Mac", new FakeClock());

    await expect(fetch("https://edge.example.test/api/health")).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 502,
      code: "bad_response",
    });
    server.close(1000, "test complete");
  });

  test("rejects every pending request when the session closes", async () => {
    const { client, server } = await makeSessions();
    server.onRecord(() => {});
    const fetch = createChannelFetch(client, "MacBook Pro", new FakeClock());
    const pending = fetch("https://edge.example.test/api/health");
    server.close(1000, "disconnected");

    await expect(pending).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 503,
      code: "connection_lost",
      message: "Lost the connection to MacBook Pro. Try again.",
    });
  });
});

async function makeSessions() {
  const [initiatorSocket, responderSocket] = createMemoryDuplexPair();
  const identity = generateStaticKeyPair();
  const responderOpening = openResponder(responderSocket, { localStatic: identity });
  const initiatorOpening = openInitiator(initiatorSocket, { remoteStaticKey: identity.publicKey });
  const [client, server] = await Promise.all([initiatorOpening, responderOpening]);
  return { client, server };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

class FakeClock implements Clock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.time = timer.at;
      this.timers.delete(id);
      timer.callback();
    }
    this.time = end;
  }
}
