export type SeenState = Readonly<Record<string, number | undefined>>;

/** Stable persistence key for a terminal's last opened turn. */
export function seenKey(machineId: string, address: string): string {
  return `seen.${machineId}.${address}`;
}

/** Whether this exact terminal turn has been opened. */
export function isSeen(
  seen: SeenState,
  machineId: string,
  address: string,
  turn: number | undefined,
): boolean {
  return turn !== undefined && seen[seenKey(machineId, address)] === turn;
}

/** Return the persisted seen map with the current turn recorded. */
export function markSeen(
  seen: SeenState,
  machineId: string,
  address: string,
  turn: number,
): SeenState {
  return { ...seen, [seenKey(machineId, address)]: turn };
}

/** Match a terminal turn only within the active paired machine. */
export function isAddressSeen(
  seen: SeenState,
  machineId: string,
  address: string,
  turn: number | undefined,
): boolean {
  return isSeen(seen, machineId, address, turn);
}
