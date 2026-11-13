import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import {
  type DuplexSocket,
  decodeBase64Url,
  openInitiator,
  type SecureSession,
} from "@herdr-mobile/secure-channel";
import type { Socket } from "./socket.ts";

export type SecureSocket = Socket & { session: Promise<SecureSession> };

/** Open a platform WebSocket and expose its authenticated Noise records as a Socket. */
export function secureSocket(route: { url: string; key: string }): SecureSocket {
  const remoteStaticKey = decodeBase64Url(route.key);
  if (remoteStaticKey.byteLength !== 32) throw new Error("Bridge identity key must be 32 bytes");

  const webSocket = new WebSocket(webSocketUrl(route.url));
  webSocket.binaryType = "arraybuffer";

  let webSocketOpen = false;
  let transportClosed = false;
  let messageListener: ((bytes: Uint8Array) => void) | undefined;
  let closeListener: ((code: number, reason: string) => void) | undefined;
  let reportedClose: { code: number; reason: string } | undefined;
  let closeNotified = false;
  const queued: Uint8Array[] = [];
  let secureSession: SecureSession | undefined;
  let socket: SecureSocket | undefined;

  const notifyClose = (event: { code: number; reason: string }) => {
    reportedClose = event;
    if (closeNotified) return;
    closeNotified = true;
    closeListener?.(event.code, event.reason);
    socket?.onclose?.(event);
  };

  const closePlatformSocket = (code: number, reason: string) => {
    if (transportClosed) return;
    transportClosed = true;
    reportedClose = { code, reason };

    const browserRejectsCode = code === 1002 || code === 1008;
    const platformCode = browserRejectsCode ? 1000 : code;
    const platformReason = browserRejectsCode ? "protocol error" : reason;
    try {
      webSocket.close(platformCode, platformReason);
    } catch {
      try {
        webSocket.close(1000, "close failed");
      } catch {
        // The logical socket still closes even if the platform adapter refuses both codes.
      }
    }
    notifyClose({ code, reason });
  };

  const duplex: DuplexSocket = {
    send(bytes) {
      if (transportClosed) throw new Error("secure WebSocket is closed");
      if (!webSocketOpen) {
        queued.push(bytes.slice());
        return;
      }
      webSocket.send(bytes);
    },
    close(code, reason) {
      closePlatformSocket(code, reason);
    },
    onMessage(listener) {
      messageListener = listener;
    },
    onClose(listener) {
      closeListener = listener;
      if (reportedClose) listener(reportedClose.code, reportedClose.reason);
    },
  };

  let resolveSession!: (session: SecureSession) => void;
  let rejectSession!: (error: unknown) => void;
  const sessionPromise = new Promise<SecureSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  socket = {
    session: sessionPromise,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (!secureSession) throw new Error("Secure WebSocket is not authenticated");
      if (typeof data === "string") secureSession.send("text", utf8Encode(data));
      else secureSession.send("binary", data);
    },
    close(code = 1000, reason = "closed") {
      if (secureSession) secureSession.close(code, reason);
      else duplex.close(code, reason);
    },
  };

  void openInitiator(duplex, { remoteStaticKey }).then((session) => {
    secureSession = session;
    session.onRecord((kind, data) => {
      if (kind === "binary") {
        const copy = data.slice();
        socket?.onmessage?.(copy.buffer);
        return;
      }

      const text = utf8Decode(data);
      if (isChannelControlRecord(text)) return;
      socket?.onmessage?.(text);
    });
    queueMicrotask(() => {
      if (!transportClosed) socket?.onopen?.();
    });
    resolveSession(session);
  }, rejectSession);

  void sessionPromise.catch(() => {});

  webSocket.onopen = () => {
    if (transportClosed) return;
    webSocketOpen = true;
    for (const bytes of queued.splice(0)) webSocket.send(bytes);
  };
  webSocket.onmessage = (event) => {
    if (transportClosed) return;
    const bytes = toBytes(event.data);
    if (bytes === undefined) {
      duplex.close(1002, "expected binary secure-channel frame");
      return;
    }
    messageListener?.(bytes);
  };
  webSocket.onclose = (event) => {
    transportClosed = true;
    notifyClose(reportedClose ?? { code: event.code, reason: event.reason });
  };
  webSocket.onerror = () => socket?.onerror?.();

  return socket;
}

function webSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isChannelControlRecord(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const type = (value as Record<string, unknown>).t;
    return typeof type === "string";
  } catch {
    return false;
  }
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}
