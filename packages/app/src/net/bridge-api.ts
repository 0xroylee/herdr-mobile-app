import type {
  DeviceRecordView,
  HttpErrorBody,
  PairReply,
  PairRequest,
} from "@herdr-mobile/protocol";

export class BridgeApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BridgeApiError";
    this.status = status;
    this.code = code;
  }
}

export type BridgeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BridgeApi {
  pair(baseUrl: string, request: PairRequest): Promise<PairReply>;
  health(baseUrl: string, token: string): Promise<unknown>;
  devices(baseUrl: string, token: string): Promise<DeviceRecordView[]>;
  revoke(baseUrl: string, token: string, id: string): Promise<void>;
  appLs(baseUrl: string, token: string): Promise<unknown>;
  appDo(
    baseUrl: string,
    token: string,
    action: "space.new" | "tab.new",
    args?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Build bridge calls over the caller's fetch implementation. */
export function createBridgeApi(fetcher: BridgeFetch): BridgeApi {
  return {
    async pair(baseUrl, request) {
      const value = await sendJson(fetcher, baseUrl, "/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!isPairReply(value)) throw new Error("The bridge returned an invalid pairing reply");
      return value;
    },
    async health(baseUrl, token) {
      return sendJson(fetcher, baseUrl, "/api/health", authorized(token));
    },
    async devices(baseUrl, token) {
      const value = await sendJson(fetcher, baseUrl, "/api/devices", authorized(token));
      if (!Array.isArray(value) || !value.every(isDeviceRecordView)) {
        throw new Error("The bridge returned an invalid device list");
      }
      return value;
    },
    async revoke(baseUrl, token, id) {
      await sendJson(
        fetcher,
        baseUrl,
        `/api/devices/${encodeURIComponent(id)}`,
        authorized(token, { method: "DELETE" }),
      );
    },
    async appLs(baseUrl, token) {
      return sendJson(fetcher, baseUrl, "/api/app/ls", authorized(token));
    },
    async appDo(baseUrl, token, action, args = {}) {
      return sendJson(
        fetcher,
        baseUrl,
        "/api/app/do",
        authorized(token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, args }),
        }),
      );
    },
  };
}

function authorized(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...toHeaders(init.headers), Authorization: `Bearer ${token}` },
  };
}

function toHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function sendJson(
  fetcher: BridgeFetch,
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}${path}`, init);
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = asHttpErrorBody(body);
    throw new BridgeApiError(
      response.status,
      error?.error ?? `http_${response.status}`,
      error?.message ?? response.statusText ?? "Bridge request failed",
    );
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function asHttpErrorBody(value: unknown): HttpErrorBody | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.error === "string" &&
    (record.message === undefined || typeof record.message === "string")
    ? { error: record.error, message: record.message as string | undefined }
    : undefined;
}

function isPairReply(value: unknown): value is PairReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const machine = record.machine;
  if (typeof machine !== "object" || machine === null || Array.isArray(machine)) return false;
  const machineRecord = machine as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.token === "string" &&
    (record.role === "watch" || record.role === "control") &&
    typeof machineRecord.id === "string" &&
    typeof machineRecord.name === "string"
  );
}

function isDeviceRecordView(value: unknown): value is DeviceRecordView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.role === "watch" || record.role === "control") &&
    typeof record.createdAt === "number" &&
    (record.lastSeenAt === null || typeof record.lastSeenAt === "number")
  );
}
