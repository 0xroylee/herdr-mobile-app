import { utf8Decode, utf8Encode } from "@herdr-mobile/hc-client";
import type { ChannelResponse } from "@herdr-mobile/protocol";
import type { SecureSession } from "@herdr-mobile/secure-channel";
import { BridgeApiError, type BridgeFetch } from "./bridge-api.ts";
import { type Clock, systemClock } from "./connection.ts";

const CHANNEL_REQUEST_TIMEOUT_MS = 20_000;

type SessionSource = SecureSession | Promise<SecureSession>;

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: unknown;
}

interface ParsedResponse {
  id: number;
  response?: ChannelResponse;
}

/** Multiplex Bridge API fetches over the authenticated secure session. */
export function createChannelFetch(
  source: SessionSource,
  machineName: string,
  clock: Clock = systemClock,
): BridgeFetch {
  const pending = new Map<number, PendingRequest>();
  let nextId = 0;
  const lostError = () =>
    new BridgeApiError(503, "connection_lost", `Lost the connection to ${machineName}. Try again.`);

  const sessionPromise = Promise.resolve(source).then(
    (session) => {
      session.onRecord((kind, data) => {
        if (kind !== "text") return;
        const reply = parseChannelResponse(utf8Decode(data));
        if (!reply) return;
        const request = pending.get(reply.id);
        if (!request) return;

        let response: Response | undefined;
        let responseError: BridgeApiError | undefined;
        try {
          if (!reply.response) throw new Error("Invalid channel response");
          response = responseFrom(reply.response);
        } catch {
          responseError = badResponseError();
        }

        clock.clearTimeout(request.timer);
        pending.delete(reply.id);
        if (responseError) request.reject(responseError);
        else if (response) request.resolve(response);
      });
      void session.closed.then(() => rejectPending(pending, lostError, clock));
      return session;
    },
    (error: unknown) => {
      rejectPending(pending, lostError, clock);
      throw error;
    },
  );
  void sessionPromise.catch(() => {});

  return async (input, init = {}) => {
    let session: SecureSession;
    try {
      session = await sessionPromise;
    } catch {
      throw lostError();
    }

    const requestId = ++nextId;
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new TypeError("Secure channel requests require a string body");
    }

    return new Promise<Response>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        pending.delete(requestId);
        reject(new BridgeApiError(504, "request_timeout", `Request to ${machineName} timed out.`));
      }, CHANNEL_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });

      const request = {
        t: "req",
        id: requestId,
        method,
        path: `${url.pathname}${url.search}`,
        ...(typeof body === "string" ? { body } : {}),
      };
      try {
        session.send("text", utf8Encode(JSON.stringify(request)));
      } catch {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) clock.clearTimeout(pendingRequest.timer);
        pending.delete(requestId);
        reject(lostError());
      }
    });
  };
}

function parseChannelResponse(text: string): ParsedResponse | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.t !== "res" || !Number.isSafeInteger(record.id)) return undefined;
    const id = record.id as number;
    if (
      !Number.isInteger(record.status) ||
      (record.status as number) < 200 ||
      (record.status as number) > 599 ||
      (record.body !== undefined && typeof record.body !== "string")
    ) {
      return { id };
    }
    return { id, response: record as unknown as ChannelResponse };
  } catch {
    return undefined;
  }
}

function badResponseError(): BridgeApiError {
  return new BridgeApiError(502, "bad_response", "The bridge returned an invalid response.");
}

function responseFrom(reply: ChannelResponse): Response {
  const body = reply.status === 204 || reply.status === 304 ? null : (reply.body ?? null);
  return new Response(body, {
    status: reply.status,
    headers: reply.body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

function rejectPending(
  pending: Map<number, PendingRequest>,
  createError: () => Error,
  clock: Clock,
): void {
  for (const [id, request] of pending) {
    clock.clearTimeout(request.timer);
    pending.delete(id);
    request.reject(createError());
  }
}
