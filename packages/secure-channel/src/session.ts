import { utf8Encode } from "@herdr-mobile/hc-client";
import type { DuplexSocket } from "./duplex.ts";
import {
  createNoiseInitiator,
  createNoiseResponder,
  generateNoiseKeyPair,
  type NoiseHandshake,
  NoiseProtocolError,
} from "./noise/index.ts";
import { decodeProtectedRecord, encodeProtectedRecord } from "./records.ts";

export const CHANNEL_PROLOGUE = "herdr-bridge-e2ee/1";
export const CHANNEL_VERSION = 1;
export const CHANNEL_CLOSE = {
  HANDSHAKE_PROTOCOL: 1002,
  RECORD_PROTOCOL: 1008,
  KEY_MISMATCH: 4003,
} as const;

const DEFAULT_DEADLINE_MS = 10_000;
const SECOND_MESSAGE_BYTES = 48;
const FIRST_MESSAGE_BYTES = 49;
const EMPTY = new Uint8Array(0);

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type TimerHost = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timerHost = globalThis as unknown as TimerHost;
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => timerHost.setTimeout(callback, ms),
  clearTimeout: (handle) => timerHost.clearTimeout(handle),
};

export class HandshakeError extends Error {
  readonly closeCode = CHANNEL_CLOSE.HANDSHAKE_PROTOCOL;

  constructor(message = "handshake protocol error") {
    super(message);
    this.name = "HandshakeError";
  }
}

export class KeyMismatchError extends Error {
  readonly closeCode = CHANNEL_CLOSE.KEY_MISMATCH;

  constructor(message = "bridge identity key mismatch") {
    super(message);
    this.name = "KeyMismatchError";
  }
}

export class RecordError extends Error {
  readonly closeCode = CHANNEL_CLOSE.RECORD_PROTOCOL;

  constructor(message = "protected record protocol error") {
    super(message);
    this.name = "RecordError";
  }
}

export class SessionClosedError extends Error {
  constructor() {
    super("secure session is closed");
    this.name = "SessionClosedError";
  }
}

export interface SecureSession {
  send(kind: "text" | "binary", data: Uint8Array): void;
  onRecord(listener: (kind: "text" | "binary", data: Uint8Array) => void): void;
  close(code: number, reason: string): void;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly handshakeHash: Uint8Array;
}

export interface StaticKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateStaticKeyPair(): StaticKeyPair {
  return generateNoiseKeyPair();
}

export function openInitiator(
  socket: DuplexSocket,
  options: { remoteStaticKey: Uint8Array; deadlineMs?: number; clock?: Clock },
): Promise<SecureSession> {
  return openHandshake(socket, "initiator", options);
}

export function openResponder(
  socket: DuplexSocket,
  options: { localStatic: StaticKeyPair; deadlineMs?: number; clock?: Clock },
): Promise<SecureSession> {
  return openHandshake(socket, "responder", options);
}

type HandshakeSide = "initiator" | "responder";
type HandshakeOptions =
  | { remoteStaticKey: Uint8Array; deadlineMs?: number; clock?: Clock }
  | { localStatic: StaticKeyPair; deadlineMs?: number; clock?: Clock };
type SessionControl = ReturnType<typeof createSessionControl>;

function openHandshake(
  socket: DuplexSocket,
  side: HandshakeSide,
  options: HandshakeOptions,
): Promise<SecureSession> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const clock = options.clock ?? systemClock;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    return Promise.reject(new HandshakeError("invalid handshake deadline"));
  }

  return new Promise<SecureSession>((resolve, reject) => {
    let handshake: NoiseHandshake;
    let localSecretCopy: Uint8Array | undefined;
    try {
      const prologue = channelPrologue();
      if (side === "initiator" && "remoteStaticKey" in options) {
        handshake = createNoiseInitiator({
          remoteStatic: new Uint8Array(options.remoteStaticKey),
          prologue,
        });
      } else if (side === "responder" && "localStatic" in options) {
        const localStatic = {
          publicKey: new Uint8Array(options.localStatic.publicKey),
          secretKey: new Uint8Array(options.localStatic.secretKey),
        };
        localSecretCopy = localStatic.secretKey;
        handshake = createNoiseResponder({ localStatic, prologue });
      } else {
        throw new HandshakeError("handshake options do not match the selected role");
      }
    } catch (error) {
      localSecretCopy?.fill(0);
      safeClose(socket, CHANNEL_CLOSE.HANDSHAKE_PROTOCOL, "handshake protocol error");
      reject(error instanceof HandshakeError ? error : new HandshakeError());
      return;
    }

    let phase: "handshake" | "open" | "closed" = "handshake";
    let timer: unknown;
    let timerStarted = false;
    let sessionControl: SessionControl | undefined;

    const clearDeadline = () => {
      if (!timerStarted) return;
      timerStarted = false;
      clock.clearTimeout(timer);
    };

    const rejectHandshake = (error: HandshakeError | KeyMismatchError, closeSocket: boolean) => {
      if (phase !== "handshake") return;
      phase = "closed";
      clearDeadline();
      handshake.clear();
      localSecretCopy?.fill(0);
      sessionControl?.dispose();
      if (closeSocket) safeClose(socket, error.closeCode, closeReason(error));
      reject(error);
    };

    const complete = () => {
      try {
        const handshakeHash = handshake.handshakeHash();
        const keys = handshake.split();
        sessionControl = createSessionControl(socket, keys.send, keys.receive, handshakeHash);
        localSecretCopy?.fill(0);
        clearDeadline();
        phase = "open";
        resolve(sessionControl.session);
      } catch {
        rejectHandshake(new HandshakeError(), true);
      }
    };

    const onClose = (code: number, reason: string) => {
      if (phase === "handshake") {
        if (code === CHANNEL_CLOSE.KEY_MISMATCH) {
          rejectHandshake(new KeyMismatchError(), false);
        } else {
          rejectHandshake(new HandshakeError(`handshake closed (${code})`), false);
        }
        return;
      }
      if (phase === "open") {
        phase = "closed";
        sessionControl?.remoteClose(code, reason);
      }
    };

    const failProtocol = (error: HandshakeError | KeyMismatchError) => {
      rejectHandshake(error, true);
    };

    const onMessage = (frame: Uint8Array) => {
      if (phase === "closed") return;
      if (phase === "open") {
        sessionControl?.receive(frame);
        return;
      }
      if (!(frame instanceof Uint8Array)) {
        failProtocol(new HandshakeError("expected a binary handshake frame"));
        return;
      }

      if (side === "initiator") {
        if (frame.byteLength !== SECOND_MESSAGE_BYTES) {
          failProtocol(new HandshakeError("invalid responder handshake message length"));
          return;
        }
        try {
          const payload = handshake.readMessage(frame);
          if (payload.byteLength !== 0) {
            failProtocol(new HandshakeError("unexpected responder handshake payload"));
            return;
          }
          complete();
        } catch (error) {
          if (error instanceof NoiseProtocolError && error.message === "authentication failed") {
            failProtocol(new KeyMismatchError());
          } else {
            failProtocol(new HandshakeError());
          }
        }
        return;
      }

      if (frame.byteLength !== FIRST_MESSAGE_BYTES) {
        failProtocol(new HandshakeError("invalid initiator handshake message length"));
        return;
      }
      if (frame[0] !== CHANNEL_VERSION) {
        failProtocol(new HandshakeError("unsupported secure channel version"));
        return;
      }

      try {
        const payload = handshake.readMessage(frame.subarray(1));
        if (payload.byteLength !== 0) {
          failProtocol(new HandshakeError("unexpected initiator handshake payload"));
          return;
        }
        const reply = handshake.writeMessage(EMPTY);
        if (reply.byteLength !== SECOND_MESSAGE_BYTES) {
          failProtocol(new HandshakeError("invalid responder handshake message length"));
          return;
        }
        const handshakeHash = handshake.handshakeHash();
        const keys = handshake.split();
        sessionControl = createSessionControl(socket, keys.send, keys.receive, handshakeHash);
        localSecretCopy?.fill(0);
        socket.send(reply);
        if (phase !== "handshake") return;
        clearDeadline();
        phase = "open";
        resolve(sessionControl.session);
      } catch (error) {
        if (phase !== "handshake") return;
        if (error instanceof NoiseProtocolError && error.message === "authentication failed") {
          failProtocol(new KeyMismatchError());
        } else {
          failProtocol(new HandshakeError());
        }
      }
    };

    socket.onMessage(onMessage);
    socket.onClose(onClose);
    if (phase !== "handshake") return;
    try {
      timer = clock.setTimeout(
        () => {
          rejectHandshake(new HandshakeError("handshake deadline exceeded"), true);
        },
        Math.max(0, deadlineMs),
      );
    } catch {
      rejectHandshake(new HandshakeError("could not start handshake deadline"), true);
      return;
    }
    if (phase !== "handshake") {
      clock.clearTimeout(timer);
      return;
    }
    timerStarted = true;

    if (side === "initiator") {
      try {
        const message = handshake.writeMessage(EMPTY);
        if (message.byteLength !== SECOND_MESSAGE_BYTES) {
          failProtocol(new HandshakeError("invalid initiator handshake message length"));
          return;
        }
        const first = new Uint8Array(FIRST_MESSAGE_BYTES);
        first[0] = CHANNEL_VERSION;
        first.set(message, 1);
        socket.send(first);
      } catch {
        failProtocol(new HandshakeError());
      }
    }
  });
}

function createSessionControl(
  socket: DuplexSocket,
  sender: ReturnType<NoiseHandshake["split"]>["send"],
  receiver: ReturnType<NoiseHandshake["split"]>["receive"],
  handshakeHash: Uint8Array,
) {
  let closed = false;
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const recordListeners: Array<(kind: "text" | "binary", data: Uint8Array) => void> = [];
  const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });

  const finish = (code: number, reason: string, closeSocket: boolean) => {
    if (closed) return;
    closed = true;
    sender.clear();
    receiver.clear();
    recordListeners.length = 0;
    if (closeSocket) safeClose(socket, code, reason);
    resolveClosed({ code, reason });
  };

  const failRecord = () => {
    if (closed) return;
    finish(CHANNEL_CLOSE.RECORD_PROTOCOL, "record protocol error", true);
  };

  const session: SecureSession = {
    send(kind, data) {
      if (closed) throw new SessionClosedError();
      try {
        socket.send(encodeProtectedRecord(kind, data, sender));
      } catch {
        const error = new RecordError("failed to send protected record");
        finish(CHANNEL_CLOSE.RECORD_PROTOCOL, "record protocol error", true);
        throw error;
      }
    },
    onRecord(listener) {
      if (!closed) recordListeners.push(listener);
    },
    close(code, reason) {
      finish(code, reason, true);
    },
    closed: closedPromise,
    get handshakeHash() {
      return handshakeHash.slice();
    },
  };

  return {
    session,
    receive(frame: Uint8Array) {
      if (closed) return;
      if (!(frame instanceof Uint8Array)) {
        failRecord();
        return;
      }
      try {
        const decoded = decodeProtectedRecord(frame, receiver);
        for (const listener of [...recordListeners]) {
          try {
            listener(decoded.kind, decoded.data.slice());
          } catch {
            // Application callbacks are isolated from transport state.
          }
        }
      } catch {
        failRecord();
      }
    },
    remoteClose(code: number, reason: string) {
      finish(code, reason, false);
    },
    dispose() {
      finish(CHANNEL_CLOSE.HANDSHAKE_PROTOCOL, "handshake abandoned", false);
    },
  };
}

function channelPrologue(): Uint8Array {
  const label = utf8Encode(CHANNEL_PROLOGUE);
  const prologue = new Uint8Array(label.byteLength + 1);
  prologue.set(label);
  prologue[label.byteLength] = CHANNEL_VERSION;
  return prologue;
}

function closeReason(error: HandshakeError | KeyMismatchError): string {
  return error instanceof KeyMismatchError ? "bridge key mismatch" : "handshake protocol error";
}

function safeClose(socket: DuplexSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The close event still settles the session if the adapter rejects close().
  }
}
