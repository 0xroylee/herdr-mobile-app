import {
  type AuthMessage,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WS_CLOSE_CODES,
  type BridgeMachine,
  type BridgeRoutes,
  type DeviceRecordView,
  type PairMessage,
  type PairReply,
} from "@herdr-mobile/protocol";
import type { DeviceStore } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";
import { createToken } from "./tokens.ts";

const MAX_FIRST_RECORD_BYTES = 1_024;

export type FirstRecordResult =
  | { kind: "auth"; device: DeviceRecordView }
  | { kind: "pair"; device: DeviceRecordView; reply: PairReply }
  | {
      kind: "reject";
      code: typeof BRIDGE_WS_CLOSE_CODES.BAD_TOKEN | typeof BRIDGE_WS_CLOSE_CODES.BAD_PAIR_CODE;
      reason: "bad_token" | "bad_code";
    };

export interface FirstRecordDependencies {
  devices: DeviceStore;
  pairing: PairingCodes;
  machine: BridgeMachine;
  routes: () => BridgeRoutes;
  bridgeKey: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthMessage(value: unknown): value is AuthMessage {
  return (
    isObject(value) &&
    value.v === BRIDGE_PROTOCOL_VERSION &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 128
  );
}

function isPairMessage(value: unknown): value is PairMessage {
  if (!isObject(value) || value.v !== BRIDGE_PROTOCOL_VERSION || !isObject(value.pair)) {
    return false;
  }
  return (
    typeof value.pair.code === "string" &&
    (value.pair.name === undefined || typeof value.pair.name === "string")
  );
}

function rejected(reason: "bad_token" | "bad_code"): FirstRecordResult {
  return {
    kind: "reject",
    code:
      reason === "bad_code" ? BRIDGE_WS_CLOSE_CODES.BAD_PAIR_CODE : BRIDGE_WS_CLOSE_CODES.BAD_TOKEN,
    reason,
  };
}

/** Authenticates the one text record allowed before a channel becomes usable. */
export async function authenticateFirstRecord(
  text: string,
  dependencies: FirstRecordDependencies,
): Promise<FirstRecordResult> {
  if (new TextEncoder().encode(text).byteLength > MAX_FIRST_RECORD_BYTES) {
    return rejected("bad_token");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return rejected("bad_token");
  }

  if (isAuthMessage(parsed)) {
    let device: DeviceRecordView | undefined;
    try {
      device = await dependencies.devices.findByToken(parsed.token);
    } catch {
      return rejected("bad_token");
    }
    if (!device || !dependencies.devices.list().some((listed) => listed.id === device?.id)) {
      return rejected("bad_token");
    }
    return { kind: "auth", device };
  }

  if (isPairMessage(parsed)) {
    const grant = dependencies.pairing.redeem(parsed.pair.code);
    if (!grant) return rejected("bad_code");
    const token = createToken();
    const name = parsed.pair.name?.trim() || grant.name;
    const device = await dependencies.devices.add({
      token,
      role: grant.role,
      ...(name === undefined ? {} : { name }),
    });
    const reply: PairReply = {
      deviceId: device.id,
      token,
      role: grant.role,
      machine: dependencies.machine,
      routes: dependencies.routes(),
      bridgeKey: dependencies.bridgeKey(),
    };
    return { kind: "pair", device, reply };
  }

  return rejected("bad_token");
}
