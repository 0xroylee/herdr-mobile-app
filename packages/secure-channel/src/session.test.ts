import { describe, expect, test } from "bun:test";
import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import { createMemoryDuplexPair, type MemoryDuplexHooks } from "./memory-duplex.ts";
import {
  CHANNEL_CLOSE,
  CHANNEL_VERSION,
  type Clock,
  generateStaticKeyPair,
  HandshakeError,
  KeyMismatchError,
  openInitiator,
  openResponder,
  SessionClosedError,
} from "./session.ts";

class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  fireAll(): void {
    this.currentTime += 10_000;
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }
}

type FrameTransform = NonNullable<MemoryDuplexHooks["transform"]>;

async function openConnectedPair() {
  let transform: FrameTransform | undefined;
  const [clientSocket, bridgeSocket] = createMemoryDuplexPair({
    transform: (direction, bytes, index) => transform?.(direction, bytes, index),
  });
  const bridgeKey = generateStaticKeyPair();
  const bridgeOpening = openResponder(bridgeSocket, { localStatic: bridgeKey });
  const clientOpening = openInitiator(clientSocket, { remoteStaticKey: bridgeKey.publicKey });
  const [client, bridge] = await Promise.all([clientOpening, bridgeOpening]);
  return {
    client,
    bridge,
    setTransform(next: FrameTransform) {
      transform = next;
    },
  };
}

async function expectResponderProtocolFailure(frame: Uint8Array): Promise<void> {
  const [peer, responderSocket] = createMemoryDuplexPair();
  const key = generateStaticKeyPair();
  const peerClose: Array<{ code: number; reason: string }> = [];
  peer.onClose((code, reason) => peerClose.push({ code, reason }));
  const opening = openResponder(responderSocket, { localStatic: key });
  peer.send(frame);
  await expect(opening).rejects.toBeInstanceOf(HandshakeError);
  expect(peerClose.map((event) => event.code)).toEqual([CHANNEL_CLOSE.HANDSHAKE_PROTOCOL]);
}

function binary(length: number, seed = 19): Uint8Array {
  return new Uint8Array(length).map((_, index) => (index * 31 + seed) & 0xff);
}

describe("secure session", () => {
  test("completes Noise NK and exchanges text and binary records both ways", async () => {
    const { client, bridge } = await openConnectedPair();
    expect(Array.from(client.handshakeHash)).toEqual(Array.from(bridge.handshakeHash));

    const received: Array<{ kind: "text" | "binary"; data: Uint8Array }> = [];
    client.onRecord((kind, data) => received.push({ kind, data }));
    bridge.onRecord((kind, data) => received.push({ kind, data }));

    client.send("text", utf8Encode("phone to bridge"));
    bridge.send("text", utf8Encode("bridge to phone"));
    client.send("binary", new Uint8Array([0, 1, 2, 255]));
    bridge.send("binary", new Uint8Array([255, 2, 1, 0]));

    expect(received.map(({ kind, data }) => [kind, utf8Decode(data)])).toEqual([
      ["text", "phone to bridge"],
      ["text", "bridge to phone"],
      ["binary", "\u0000\u0001\u0002�"],
      ["binary", "�\u0002\u0001\u0000"],
    ]);
  });

  test("keeps a Buffer-backed static secret unchanged across two sessions", async () => {
    const generated = generateStaticKeyPair();
    const bridgeKey = {
      publicKey: Buffer.from(generated.publicKey),
      secretKey: Buffer.from(generated.secretKey),
    };
    const originalSecret = Buffer.from(bridgeKey.secretKey);

    for (let index = 0; index < 2; index += 1) {
      const [clientSocket, bridgeSocket] = createMemoryDuplexPair();
      const bridgeOpening = openResponder(bridgeSocket, { localStatic: bridgeKey });
      const clientOpening = openInitiator(clientSocket, { remoteStaticKey: bridgeKey.publicKey });
      const [client, bridge] = await Promise.all([clientOpening, bridgeOpening]);
      client.close(1000, "test complete");
      await Promise.all([client.closed, bridge.closed]);
    }

    expect(bridgeKey.secretKey).toEqual(originalSecret);
  });

  test("carries a 300 KiB record in five protected chunks", async () => {
    const { client, bridge } = await openConnectedPair();
    const payload = binary(300 * 1024);
    let received: Uint8Array | undefined;
    bridge.onRecord((kind, data) => {
      expect(kind).toBe("binary");
      received = data;
    });
    client.send("binary", payload);
    expect(received).toBeDefined();
    expect(Array.from(received as Uint8Array)).toEqual(Array.from(payload));
  });

  test("rejects a responder with a different static key as a key mismatch", async () => {
    const pinnedKey = generateStaticKeyPair();
    const actualKey = generateStaticKeyPair();
    const [clientSocket, bridgeSocket] = createMemoryDuplexPair();
    const clientCloses: number[] = [];
    const bridgeCloses: number[] = [];
    clientSocket.onClose((code) => clientCloses.push(code));
    bridgeSocket.onClose((code) => bridgeCloses.push(code));

    const bridgeOpening = openResponder(bridgeSocket, { localStatic: actualKey });
    const clientOpening = openInitiator(clientSocket, { remoteStaticKey: pinnedKey.publicKey });
    await expect(clientOpening).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(bridgeOpening).rejects.toBeInstanceOf(KeyMismatchError);
    expect(clientCloses).toEqual([CHANNEL_CLOSE.KEY_MISMATCH]);
    expect(bridgeCloses).toEqual([CHANNEL_CLOSE.KEY_MISMATCH]);
  });

  test("closes with 4003 when message 2 fails its authentication check", async () => {
    const bridgeKey = generateStaticKeyPair();
    const [clientSocket, bridgeSocket] = createMemoryDuplexPair({
      transform: (direction, bytes) => {
        if (direction !== "second-to-first") return undefined;
        const tampered = bytes.slice();
        const last = tampered.byteLength - 1;
        tampered[last] = (tampered[last] as number) ^ 1;
        return [tampered];
      },
    });
    const clientCloses: number[] = [];
    const bridgeCloses: number[] = [];
    clientSocket.onClose((code) => clientCloses.push(code));
    bridgeSocket.onClose((code) => bridgeCloses.push(code));

    const bridgeOpening = openResponder(bridgeSocket, { localStatic: bridgeKey });
    const clientOpening = openInitiator(clientSocket, { remoteStaticKey: bridgeKey.publicKey });
    await expect(clientOpening).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(bridgeOpening).rejects.toBeInstanceOf(KeyMismatchError);
    expect(clientCloses).toEqual([CHANNEL_CLOSE.KEY_MISMATCH]);
    expect(bridgeCloses).toEqual([CHANNEL_CLOSE.KEY_MISMATCH]);
  });

  test("a replayed message 1 cannot establish a usable session or reuse captured records", async () => {
    const bridgeKey = generateStaticKeyPair();
    let capturedMessage1: Uint8Array | undefined;
    let capturedMessage2: Uint8Array | undefined;
    let capturedApplicationRecord: Uint8Array | undefined;
    const [clientSocket, originalResponderSocket] = createMemoryDuplexPair({
      transform: (direction, bytes, index) => {
        if (direction === "first-to-second" && index === 0) capturedMessage1 = bytes.slice();
        if (direction === "second-to-first" && index === 0) capturedMessage2 = bytes.slice();
        if (direction === "first-to-second" && index === 1) {
          capturedApplicationRecord = bytes.slice();
        }
        return undefined;
      },
    });
    const originalOpening = openResponder(originalResponderSocket, { localStatic: bridgeKey });
    const clientOpening = openInitiator(clientSocket, { remoteStaticKey: bridgeKey.publicKey });
    const [client, originalResponder] = await Promise.all([clientOpening, originalOpening]);
    expect(capturedMessage1?.byteLength).toBe(49);
    client.send("binary", new Uint8Array([7, 8, 9]));
    expect(capturedApplicationRecord).toBeDefined();
    client.close(1000, "test complete");
    originalResponder.close(1000, "test complete");

    const [replayInitiatorSocket, replayResponderSocket] = createMemoryDuplexPair({
      transform: (direction, bytes, index) => {
        if (direction === "first-to-second" && index === 0) {
          return [capturedMessage1 as Uint8Array];
        }
        if (direction === "second-to-first" && index === 0) {
          expect(bytes).not.toEqual(capturedMessage2);
        }
        return undefined;
      },
    });
    const replayResponderOpening = openResponder(replayResponderSocket, { localStatic: bridgeKey });
    const replayInitiatorOpening = openInitiator(replayInitiatorSocket, {
      remoteStaticKey: bridgeKey.publicKey,
    });
    const replayResponderFailure =
      expect(replayResponderOpening).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(replayInitiatorOpening).rejects.toBeInstanceOf(KeyMismatchError);
    await replayResponderFailure;

    const [replayPeer, freshResponderSocket] = createMemoryDuplexPair();
    const freshOpening = openResponder(freshResponderSocket, { localStatic: bridgeKey });
    replayPeer.send(capturedMessage1 as Uint8Array);
    const freshResponder = await freshOpening;
    const delivered: Uint8Array[] = [];
    freshResponder.onRecord((_kind, data) => delivered.push(data));
    replayPeer.send(capturedApplicationRecord as Uint8Array);
    expect(await freshResponder.closed).toEqual({
      code: CHANNEL_CLOSE.RECORD_PROTOCOL,
      reason: "record protocol error",
    });
    expect(delivered).toHaveLength(0);
  });

  test("closes with 1002 for an unsupported version byte", async () => {
    const message = new Uint8Array(49);
    message[0] = CHANNEL_VERSION + 1;
    await expectResponderProtocolFailure(message);
  });

  test("closes with 1002 for every message 1 length other than 49", async () => {
    for (const length of [0, 1, 48, 50, 98]) {
      const message = new Uint8Array(length);
      if (length > 0) message[0] = CHANNEL_VERSION;
      await expectResponderProtocolFailure(message);
    }
  });

  test("closes with 1002 for a text frame before split", async () => {
    const [peer, responderSocket] = createMemoryDuplexPair();
    const key = generateStaticKeyPair();
    const closes: number[] = [];
    peer.onClose((code) => closes.push(code));
    const opening = openResponder(responderSocket, { localStatic: key });
    peer.send("text frame" as unknown as Uint8Array);
    await expect(opening).rejects.toBeInstanceOf(HandshakeError);
    expect(closes).toEqual([CHANNEL_CLOSE.HANDSHAKE_PROTOCOL]);
  });

  test("closes with 1002 when the initiator receives an out-of-turn frame", async () => {
    const [initiatorSocket, peer] = createMemoryDuplexPair();
    const key = generateStaticKeyPair();
    const closes: number[] = [];
    initiatorSocket.onClose((code) => closes.push(code));
    const opening = openInitiator(initiatorSocket, { remoteStaticKey: key.publicKey });
    peer.send(new Uint8Array(49));
    await expect(opening).rejects.toBeInstanceOf(HandshakeError);
    expect(closes).toEqual([CHANNEL_CLOSE.HANDSHAKE_PROTOCOL]);
  });

  test("expires the handshake deadline with a fake clock", async () => {
    const [initiatorSocket] = createMemoryDuplexPair();
    const key = generateStaticKeyPair();
    const clock = new FakeClock();
    const closes: number[] = [];
    initiatorSocket.onClose((code) => closes.push(code));
    const opening = openInitiator(initiatorSocket, {
      remoteStaticKey: key.publicKey,
      deadlineMs: 250,
      clock,
    });
    clock.fireAll();
    await expect(opening).rejects.toBeInstanceOf(HandshakeError);
    expect(closes).toEqual([CHANNEL_CLOSE.HANDSHAKE_PROTOCOL]);
  });

  const recordFailures: Array<{
    name: string;
    transform: (bytes: Uint8Array, index: number) => readonly Uint8Array[] | null | undefined;
    sendCount: number;
  }> = [
    {
      name: "a bad tag closes both ends with 1008",
      transform: (bytes, index) => {
        if (index !== 0) return undefined;
        const damaged = bytes.slice();
        const last = damaged.byteLength - 1;
        damaged[last] = (damaged[last] as number) ^ 1;
        return [damaged];
      },
      sendCount: 1,
    },
    {
      name: "a dropped protected record closes both ends with 1008",
      transform: (_bytes, index) => (index === 0 ? [] : undefined),
      sendCount: 2,
    },
    {
      name: "a duplicated record closes both ends with 1008",
      transform: (bytes, index) => (index === 0 ? [bytes, bytes] : undefined),
      sendCount: 1,
    },
    {
      name: "reordered records close both ends with 1008",
      transform: (() => {
        let held: Uint8Array | undefined;
        return (bytes: Uint8Array, index: number) => {
          if (index === 0) {
            held = bytes.slice();
            return [];
          }
          return held ? [bytes, held] : undefined;
        };
      })(),
      sendCount: 2,
    },
  ];

  for (const failure of recordFailures) {
    test(failure.name, async () => {
      const { client, bridge, setTransform } = await openConnectedPair();
      let recordIndex = 0;
      setTransform((direction, bytes) => {
        if (direction !== "first-to-second") return undefined;
        return failure.transform(bytes, recordIndex++);
      });

      for (let index = 0; index < failure.sendCount; index += 1) {
        client.send("binary", new Uint8Array([index + 1]));
      }
      const [clientClose, bridgeClose] = await Promise.all([client.closed, bridge.closed]);
      expect(clientClose).toEqual({
        code: CHANNEL_CLOSE.RECORD_PROTOCOL,
        reason: "record protocol error",
      });
      expect(bridgeClose).toEqual({
        code: CHANNEL_CLOSE.RECORD_PROTOCOL,
        reason: "record protocol error",
      });
    });
  }

  test("a failed record is not delivered to listeners that try to send or close", async () => {
    for (const action of ["send", "close"] as const) {
      const { client, bridge, setTransform } = await openConnectedPair();
      let delivered = 0;
      let recordIndex = 0;
      setTransform((direction, bytes) => {
        if (direction !== "first-to-second" || recordIndex++ !== 0) return undefined;
        const damaged = bytes.slice();
        const last = damaged.byteLength - 1;
        damaged[last] = (damaged[last] as number) ^ 1;
        return [damaged];
      });
      bridge.onRecord(() => {
        delivered += 1;
        if (action === "send") client.send("binary", new Uint8Array([42]));
        else bridge.close(1000, "closed by record listener");
      });

      client.send("binary", new Uint8Array([1]));
      const [clientClose, bridgeClose] = await Promise.all([client.closed, bridge.closed]);
      expect(delivered).toBe(0);
      expect(clientClose).toEqual({
        code: CHANNEL_CLOSE.RECORD_PROTOCOL,
        reason: "record protocol error",
      });
      expect(bridgeClose).toEqual({
        code: CHANNEL_CLOSE.RECORD_PROTOCOL,
        reason: "record protocol error",
      });
    }
  });

  test("send throws SessionClosedError after a local close", async () => {
    const { client, bridge } = await openConnectedPair();
    client.close(1000, "finished");
    const closes = await Promise.all([client.closed, bridge.closed]);
    expect(closes.map(({ code }) => code)).toEqual([1000, 1000]);
    expect(() => client.send("text", utf8Encode("after close"))).toThrow(SessionClosedError);
  });
});
