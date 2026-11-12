import type { ChannelRequest, ChannelResponse, DeviceRecordView } from "@herdr-mobile/protocol";
import type { SecureSession } from "@herdr-mobile/secure-channel";
import type { ResolveCaller } from "./caller.ts";
import { boundCaller } from "./caller.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_IN_FLIGHT = 8;
const encoder = new TextEncoder();

export type DispatchApi = (
  request: Request,
  resolveCaller: ResolveCaller,
) => Promise<Response | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChannelRequest(value: unknown): value is ChannelRequest {
  return (
    isRecord(value) &&
    value.t === "req" &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    (value.body === undefined || typeof value.body === "string")
  );
}

function encodeResponse(response: ChannelResponse): Uint8Array {
  return encoder.encode(JSON.stringify(response));
}

function responseBody(error: string): string {
  return JSON.stringify({ error });
}

/** Multiplexes authenticated HTTP API requests over one secure session. */
export function createChannelApi(
  session: SecureSession,
  device: DeviceRecordView,
  dispatchApi: DispatchApi,
  onDeviceRevocation?: () => void,
): { receive(bytes: Uint8Array): void; close(): void } {
  let inFlight = 0;
  let closed = false;
  const resolveCaller = boundCaller(device);

  const sendResponse = (id: number, status: number, body?: string) => {
    if (closed) return;
    const response: ChannelResponse = {
      t: "res",
      id,
      status,
      ...(body === undefined ? {} : { body }),
    };
    try {
      session.send("text", encodeResponse(response));
    } catch {
      closed = true;
    }
  };

  const dispatch = async (request: ChannelRequest) => {
    let path: string;
    try {
      path = new URL(`http://bridge.internal${request.path}`).pathname;
    } catch {
      sendResponse(request.id, 404, responseBody("not_found"));
      return;
    }
    if (!path.startsWith("/api/") || path === "/api/pair") {
      sendResponse(request.id, 404, responseBody("not_found"));
      return;
    }
    if (request.body !== undefined && encoder.encode(request.body).byteLength > MAX_BODY_BYTES) {
      sendResponse(request.id, 413, responseBody("body_too_large"));
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      sendResponse(request.id, 429, responseBody("too_many_requests"));
      return;
    }

    let incoming: Request;
    try {
      incoming = new Request(`http://bridge.internal${request.path}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch {
      sendResponse(request.id, 400, responseBody("bad_request"));
      return;
    }

    inFlight++;
    try {
      const response =
        (await dispatchApi(incoming, resolveCaller)) ?? new Response(null, { status: 404 });
      const closesRevokedSessions =
        response.status === 204 &&
        request.method === "DELETE" &&
        /^\/api\/devices(?:\/|$)/u.test(path);
      const body = await response.text();
      sendResponse(request.id, response.status, body || undefined);
      if (closesRevokedSessions) onDeviceRevocation?.();
    } catch {
      sendResponse(request.id, 500, responseBody("internal_error"));
    } finally {
      inFlight--;
    }
  };

  session.closed.then(() => {
    closed = true;
  });

  return {
    receive(bytes) {
      if (closed) return;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        session.close(1008, "record protocol error");
        closed = true;
        return;
      }
      if (!isRecord(value)) {
        session.close(1008, "record protocol error");
        closed = true;
        return;
      }
      if (value.t !== "req") return;
      if (!isChannelRequest(value)) {
        session.close(1008, "record protocol error");
        closed = true;
        return;
      }
      void dispatch(value);
    },
    close() {
      closed = true;
    },
  };
}
