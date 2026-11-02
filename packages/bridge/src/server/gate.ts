import {
  encodeFrame,
  FrameDecoder,
  LineDecoder,
  utf8Decode,
  utf8Encode,
} from "@herdr-mobile/hc-client";
import {
  FRAME_HEADER_BYTES,
  FrameKind,
  isAllowed,
  type JsonValue,
  type Role,
} from "@herdr-mobile/protocol";

export interface PhoneGateResult {
  toCore: Uint8Array;
  toPhone: Uint8Array;
}

export interface CoreGateResult {
  toPhone: Uint8Array;
}

export interface Gate {
  fromPhone(bytes: Uint8Array): PhoneGateResult;
  fromCore(bytes: Uint8Array): CoreGateResult;
}

type RpcRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function hasOwn(record: RpcRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0] as Uint8Array;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return concat([left, right]);
}

function errorReply(id: unknown, method: string | undefined, framed: boolean): Uint8Array {
  const observeHint =
    method === "terminal.attach"
      ? "Use observe: true to open an attachment with watch access."
      : "This method is not available to this device role.";
  const message =
    method === undefined
      ? "A request without a string method is forbidden for this device role."
      : `Method ${method} is forbidden for this device role.`;
  const reply = {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message,
      data: { kind: "forbidden", hint: observeHint },
    },
  };
  const payload = utf8Encode(JSON.stringify(reply));
  return framed
    ? encodeFrame({ channel: 0, kind: FrameKind.Data, payload })
    : utf8Encode(`${JSON.stringify(reply)}\n`);
}

/** Filters channel 0 by role while preserving the core protocol's plain-to-framed transition. */
export function createGate(role: Role): Gate {
  return new RoleGate(role);
}

class RoleGate implements Gate {
  private mode: "plain" | "framed" = "plain";
  private readonly phoneLines = new LineDecoder();
  private readonly coreLines = new LineDecoder();
  private readonly phoneFrames = new FrameDecoder();
  private readonly coreFrames = new FrameDecoder();
  /** Mirrors unconsumed decoder bytes so accepted plain lines can retain their original delimiter. */
  private phoneRaw: Uint8Array = new Uint8Array(0);
  private coreRaw: Uint8Array = new Uint8Array(0);
  private readonly framedHelloIds = new Set<unknown>();
  private readonly role: Role;

  constructor(role: Role) {
    this.role = role;
  }

  fromPhone(bytes: Uint8Array): PhoneGateResult {
    if (this.mode === "framed") return this.fromFramedPhone(bytes);

    this.phoneLines.push(bytes);
    this.phoneRaw = append(this.phoneRaw, bytes);
    const toCore: Uint8Array[] = [];
    const toPhone: Uint8Array[] = [];
    let line = this.phoneLines.takeLine();

    while (line) {
      const raw = this.phoneRaw.subarray(0, line.consumed);
      this.phoneRaw = this.phoneRaw.subarray(line.consumed);
      const request = parse(line.line);
      if (isRecord(request)) {
        const method = typeof request.method === "string" ? request.method : undefined;
        const params = request.params as JsonValue | undefined;
        if (method !== undefined && isAllowed(this.role, method, params)) {
          toCore.push(raw);
          if (
            method === "hello" &&
            isRecord(params) &&
            params.framed === true &&
            hasOwn(request, "id")
          ) {
            this.framedHelloIds.add(request.id);
          }
        } else if (hasOwn(request, "id")) {
          toPhone.push(errorReply(request.id, method, false));
        }
      }
      line = this.phoneLines.takeLine();
    }

    return { toCore: concat(toCore), toPhone: concat(toPhone) };
  }

  fromCore(bytes: Uint8Array): CoreGateResult {
    if (this.mode === "framed") return { toPhone: this.forwardCoreFrames(bytes) };

    this.coreLines.push(bytes);
    this.coreRaw = append(this.coreRaw, bytes);
    const toPhone: Uint8Array[] = [];
    let line = this.coreLines.takeLine();
    while (line) {
      const raw = this.coreRaw.subarray(0, line.consumed);
      this.coreRaw = this.coreRaw.subarray(line.consumed);
      toPhone.push(raw);
      if (this.acceptCoreLine(line.line)) {
        this.mode = "framed";
        const rest = this.coreLines.drain();
        this.coreRaw = new Uint8Array(0);
        toPhone.push(this.forwardCoreFrames(rest));
        break;
      }
      line = this.coreLines.takeLine();
    }

    return { toPhone: concat(toPhone) };
  }

  private fromFramedPhone(bytes: Uint8Array): PhoneGateResult {
    // A partial plain buffer can only switch interpretation after the core confirms hello.
    const pendingPlainBytes = this.phoneLines.drain();
    this.phoneRaw = new Uint8Array(0);
    const frames = this.phoneFrames.push(append(pendingPlainBytes, bytes));
    const toCore: Uint8Array[] = [];
    const toPhone: Uint8Array[] = [];

    for (const frame of frames) {
      if (frame.channel !== 0) {
        toCore.push(encodeFrame(frame));
        continue;
      }
      if (frame.kind !== FrameKind.Data) continue;

      const request = parse(frame.payload);
      if (!isRecord(request)) continue;
      const method = typeof request.method === "string" ? request.method : undefined;
      const params = request.params as JsonValue | undefined;
      if (method !== undefined && isAllowed(this.role, method, params)) {
        toCore.push(encodeFrame(frame));
      } else if (hasOwn(request, "id")) {
        toPhone.push(errorReply(request.id, method, true));
      }
    }

    return { toCore: concat(toCore), toPhone: concat(toPhone) };
  }

  private forwardCoreFrames(bytes: Uint8Array): Uint8Array {
    this.coreRaw = append(this.coreRaw, bytes);
    const frames = this.coreFrames.push(bytes);
    const completeLength = frames.reduce(
      (length, frame) => length + FRAME_HEADER_BYTES + frame.payload.length,
      0,
    );
    const complete = this.coreRaw.subarray(0, completeLength);
    this.coreRaw = this.coreRaw.subarray(completeLength);
    return complete;
  }

  private acceptCoreLine(bytes: Uint8Array): boolean {
    const reply = parse(bytes);
    if (!isRecord(reply) || !hasOwn(reply, "id") || !this.framedHelloIds.has(reply.id)) {
      return false;
    }
    this.framedHelloIds.delete(reply.id);
    if (hasOwn(reply, "error") || !isRecord(reply.result) || reply.result.framed !== true) {
      return false;
    }
    return true;
  }
}
