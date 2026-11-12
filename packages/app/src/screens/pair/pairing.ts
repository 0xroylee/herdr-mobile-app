import type { PairReply } from "@herdr-mobile/protocol";
import { type BridgeApi, BridgeApiError } from "../../net/bridge-api.ts";
import { type PairInput, parsePairFragment, parseTypedPairInput } from "../../net/pair-link.ts";
import type { machinesStore } from "../../store/platform.ts";
import type { Secrets } from "../../store/secrets.ts";

export interface PairedDevice {
  machineName: string;
  deviceName: string;
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
  input: PairInput,
  api: BridgeApi,
  secrets: Secrets,
  machines: typeof machinesStore,
  name?: string,
): Promise<PairedDevice> {
  const direct = input.direct as string;
  const reply: PairReply = await api.pair(direct, {
    code: input.code,
    ...(name ? { name } : {}),
  });

  await secrets.set(reply.machine.id, reply.token);
  const machine = {
    id: reply.machine.id,
    name: reply.machine.name,
    routes: { direct },
    role: reply.role,
    deviceId: reply.deviceId,
  };
  machines.getState().addMachine(machine);
  machines.getState().setActiveId(machine.id);

  return {
    machineName: machine.name,
    deviceName: name ?? "Phone",
  };
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof BridgeApiError) {
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
      return "The bridge couldn't complete pairing. Try again.";
    }
  }

  if (error instanceof TypeError) {
    return "Can't reach the bridge. Check the address and that Tailscale is on.";
  }
  return "Pairing couldn't be completed on this device. Try again.";
}

export function pairingCanRetry(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof BridgeApiError && (error.status === 403 || error.status >= 500))
  );
}
