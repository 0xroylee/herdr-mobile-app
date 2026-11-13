import { BRIDGE_PROTOCOL_VERSION, type PairMessage, type PairReply } from "@herdr-mobile/protocol";
import { type BridgeApi, BridgeApiError } from "../../net/bridge-api.ts";
import { type PairInput, parsePairFragment, parseTypedPairInput } from "../../net/pair-link.ts";
import type { RouteOpener } from "../../net/route-opener.ts";
import type { Machine } from "../../store/machines.ts";
import type { machinesStore } from "../../store/platform.ts";
import type { Secrets } from "../../store/secrets.ts";

const PAIR_REPLY_TIMEOUT_MS = 5_000;

export interface PairedDevice {
  machineName: string;
  deviceName: string;
}

export type PairingOutcome =
  | (PairedDevice & { kind: "paired" })
  | { kind: "refreshed"; machineName: string };

export interface PairingDependencies {
  api: BridgeApi;
  openRoute: RouteOpener;
  secrets: Secrets;
  machines: typeof machinesStore;
  restartConnection?: (machineId: string) => void;
}

/** Accept either a complete bridge pairing link or the two manually entered fields. */
export function parsePairingInput(address: string, code: string): PairInput | undefined {
  return parsePairFragment(address) ?? parseTypedPairInput(address, code);
}

/** Resolve a readable device name while keeping the bridge's id for storage and API identity. */
export function pairingDeviceName(name: string | null | undefined, isWeb: boolean): string {
  return name?.trim() || (isWeb ? "Browser" : "Phone");
}

/** Redeem a code, keep its token in Secrets, and persist only public machine data. */
export async function pairAndStore(
  offer: PairInput,
  deps: PairingDependencies,
  name?: string,
): Promise<PairingOutcome> {
  const existing = findMachineForKey(offer, deps.machines);
  if (existing) {
    if (offer.secure && existing.routes.secure) {
      deps.machines.getState().updateRoutes(existing.id, {
        ...existing.routes,
        secure: { url: offer.secure, key: existing.routes.secure.key },
      });
    }
    deps.machines.getState().setActiveId(existing.id);
    return { kind: "refreshed", machineName: existing.name };
  }

  const request = { code: offer.code, ...(name ? { name } : {}) };
  let reply: PairReply;
  let pairedOverSecure = false;

  if (offer.secure && offer.bridgeKey) {
    try {
      reply = await pairOverSecureRoute(offer, deps.openRoute, request);
      pairedOverSecure = true;
    } catch (error) {
      if (!offer.direct || !canFallBackToDirect(error)) throw error;
      reply = await deps.api.pair(offer.direct, request);
    }
  } else if (offer.direct) {
    reply = await deps.api.pair(offer.direct, request);
  } else {
    throw new BridgeApiError(400, "invalid_pair_offer", "The pairing link has no usable route");
  }

  const machineWasActive = deps.machines.getState().activeId === reply.machine.id;
  await deps.secrets.set(reply.machine.id, reply.token);

  const direct = reply.routes.direct;
  const secureUrl = reply.routes.secure ?? (pairedOverSecure ? offer.secure : undefined);
  const secureKey = pairedOverSecure ? offer.bridgeKey : reply.bridgeKey;
  const machine = {
    id: reply.machine.id,
    name: reply.machine.name,
    routes: {
      ...(direct === undefined ? {} : { direct }),
      ...(secureUrl === undefined || secureKey === undefined
        ? {}
        : { secure: { url: secureUrl, key: secureKey } }),
    },
    role: reply.role,
    deviceId: reply.deviceId,
  };
  deps.machines.getState().addMachine(machine);
  deps.machines.getState().setActiveId(machine.id);
  if (machineWasActive) deps.restartConnection?.(machine.id);

  return {
    kind: "paired",
    machineName: machine.name,
    deviceName: name ?? "Phone",
  };
}

function findMachineForKey(offer: PairInput, machines: typeof machinesStore): Machine | undefined {
  if (!offer.bridgeKey) return undefined;
  return Object.values(machines.getState().machines).find(
    (machine) => machine.routes.secure?.key === offer.bridgeKey,
  );
}

function pairOverSecureRoute(
  offer: PairInput,
  openRoute: RouteOpener,
  request: { code: string; name?: string },
): Promise<PairReply> {
  if (!offer.secure || !offer.bridgeKey) {
    return Promise.reject(new PairingChannelError(undefined, false));
  }

  let connection: ReturnType<RouteOpener>;
  try {
    connection = openRoute({ kind: "secure", url: offer.secure, key: offer.bridgeKey });
  } catch {
    return Promise.reject(new PairingChannelError(undefined, false));
  }

  return new Promise<PairReply>((resolve, reject) => {
    const { socket } = connection;
    let settled = false;
    let codeMayHaveBeenRedeemed = false;
    const timeout = setTimeout(() => {
      finishReject(new PairingChannelError(undefined, codeMayHaveBeenRedeemed));
    }, PAIR_REPLY_TIMEOUT_MS);

    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      return true;
    };

    const finishReject = (error: PairingChannelError) => {
      if (!finish()) return;
      try {
        socket.close(1000, "pairing failed");
      } catch {
        // The pairing error is still reported when the socket has already closed.
      }
      reject(error);
    };

    socket.onopen = () => {
      if (settled || codeMayHaveBeenRedeemed) return;
      const message: PairMessage = {
        v: BRIDGE_PROTOCOL_VERSION,
        pair: request,
      };
      try {
        socket.send(JSON.stringify(message));
        codeMayHaveBeenRedeemed = true;
      } catch {
        finishReject(new PairingChannelError(undefined, false));
      }
    };

    socket.onmessage = (data) => {
      if (typeof data !== "string") {
        finishReject(new PairingChannelError(undefined, true));
        return;
      }
      const reply = parsePairReply(data);
      if (!reply) {
        finishReject(new PairingChannelError(undefined, true));
        return;
      }
      if (!finish()) return;
      try {
        socket.close(1000, "pairing complete");
      } catch {
        // The reply is complete even if the platform socket refuses a close after it.
      }
      resolve(reply);
    };

    socket.onclose = ({ code }) => {
      const codeWasRejected = code === 4402;
      finishReject(new PairingChannelError(code, codeMayHaveBeenRedeemed && !codeWasRejected));
    };

    socket.onerror = () => {
      finishReject(new PairingChannelError(undefined, codeMayHaveBeenRedeemed));
    };
  });
}

function parsePairReply(data: string): PairReply | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const machine = record.machine;
    const routes = record.routes;
    if (
      typeof record.deviceId !== "string" ||
      typeof record.token !== "string" ||
      (record.role !== "control" && record.role !== "watch") ||
      typeof record.bridgeKey !== "string" ||
      typeof machine !== "object" ||
      machine === null ||
      Array.isArray(machine) ||
      typeof routes !== "object" ||
      routes === null ||
      Array.isArray(routes)
    ) {
      return undefined;
    }
    const machineRecord = machine as Record<string, unknown>;
    const routeRecord = routes as Record<string, unknown>;
    if (
      typeof machineRecord.id !== "string" ||
      typeof machineRecord.name !== "string" ||
      (routeRecord.direct !== undefined && typeof routeRecord.direct !== "string") ||
      (routeRecord.secure !== undefined && typeof routeRecord.secure !== "string")
    ) {
      return undefined;
    }
    return {
      deviceId: record.deviceId,
      token: record.token,
      role: record.role,
      machine: { id: machineRecord.id, name: machineRecord.name },
      routes: {
        ...(typeof routeRecord.direct === "string" ? { direct: routeRecord.direct } : {}),
        ...(typeof routeRecord.secure === "string" ? { secure: routeRecord.secure } : {}),
      },
      bridgeKey: record.bridgeKey,
    };
  } catch {
    return undefined;
  }
}

function canFallBackToDirect(error: unknown): boolean {
  return (
    error instanceof PairingChannelError &&
    (!error.codeMayHaveBeenRedeemed || error.closeCode === 4402)
  );
}

class PairingChannelError extends BridgeApiError {
  readonly closeCode: number | undefined;
  readonly codeMayHaveBeenRedeemed: boolean;

  constructor(closeCode: number | undefined, codeMayHaveBeenRedeemed: boolean) {
    const status = closeCode === 4003 || closeCode === 4402 ? closeCode : 503;
    const code =
      closeCode === 4003
        ? "key_mismatch"
        : closeCode === 4402
          ? "bad_pair_code"
          : "secure_pair_failed";
    super(status, code, "Secure pairing failed");
    this.name = "PairingChannelError";
    this.closeCode = closeCode;
    this.codeMayHaveBeenRedeemed = codeMayHaveBeenRedeemed;
  }
}

export function pairingErrorMessage(error: unknown, offer?: PairInput): string {
  if (error instanceof BridgeApiError) {
    if (error.status === 4003 || error.code === "key_mismatch") {
      return "This Mac's bridge identity changed. Pair again.";
    }
    if (error.status === 4402 || error.code === "bad_pair_code") {
      return "That pairing code is invalid or has expired. Generate a new code on your Mac.";
    }
    if (error.status === 403) {
      return "This bridge is unavailable to this device. Check that Tailscale is on.";
    }
    if (error.status === 400 && error.code === "bad_code") {
      return "That pairing code is invalid or has expired. Generate a new code on your Mac.";
    }
    if (error.status === 400) {
      return "The pairing link or address is invalid. Check the bridge URL and code.";
    }
    if (error.status >= 500) {
      return offer && !offer.bridgeKey
        ? "Typing works over Tailscale. Without it, scan the code or paste the full link."
        : "The bridge couldn't complete pairing. Try again.";
    }
  }

  if (error instanceof TypeError) {
    return offer && !offer.bridgeKey
      ? "Typing works over Tailscale. Without it, scan the code or paste the full link."
      : "Can't reach the bridge. Check the address and that Tailscale is on.";
  }
  return "Pairing couldn't be completed on this device. Try again.";
}

export function pairingCanRetry(error: unknown): boolean {
  if (error instanceof PairingChannelError && error.codeMayHaveBeenRedeemed) return false;
  return (
    error instanceof TypeError ||
    (error instanceof BridgeApiError && (error.status === 403 || error.status >= 500))
  );
}
