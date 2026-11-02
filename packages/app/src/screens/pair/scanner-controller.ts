import type { PairInput } from "../../net/pair-link.ts";
import { parsePairFragment } from "../../net/pair-link.ts";

export interface ScannerState {
  message?: string;
  accepted: boolean;
}

export function createScannerController() {
  let state: ScannerState = { accepted: false };
  const listeners = new Set<() => void>();

  const update = (next: ScannerState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    scan(value: string): PairInput | undefined {
      if (state.accepted) return undefined;
      const input = parsePairFragment(value);
      if (!input) {
        if (!state.message) {
          update({ message: "This QR code isn't a Herdr pairing code.", accepted: false });
        }
        return undefined;
      }
      update({ accepted: true });
      return input;
    },
    reset() {
      if (state.accepted || state.message) update({ accepted: false });
    },
  };
}
