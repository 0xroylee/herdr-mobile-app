import type { PairInput } from "../../net/pair-link.ts";
import { parsePairFragment } from "../../net/pair-link.ts";

type PairLocation = Pick<Location, "href" | "hash" | "pathname" | "search">;
type PairHistory = Pick<History, "state" | "replaceState">;

export interface PairFragmentHandoff {
  hasPending(): boolean;
  shouldRedirectToPair(hasPairedMachine: boolean): boolean;
  consume(): PairInput | undefined;
}

/** Capture a valid pairing fragment and remove it from the browser address bar. */
export function createPairFragmentHandoff(
  location?: PairLocation,
  history?: PairHistory,
): PairFragmentHandoff {
  let pending = location ? parsePairFragment(location.href) : undefined;

  if (pending && location && history) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }

  return {
    hasPending: () => pending !== undefined,
    shouldRedirectToPair: (hasPairedMachine) => pending !== undefined || !hasPairedMachine,
    consume() {
      const input = pending;
      pending = undefined;
      return input;
    },
  };
}

function captureInitialBrowserFragment(): PairFragmentHandoff {
  if (typeof window === "undefined") return createPairFragmentHandoff();
  return createPairFragmentHandoff(window.location, window.history);
}

const initialPairFragment = captureInitialBrowserFragment();

/** True while a captured link still needs to enter the pairing flow. */
export function hasCapturedPairFragment(): boolean {
  return initialPairFragment.hasPending();
}

/** Consume the captured link exactly once, after the pairing screen mounts. */
export function consumeCapturedPairFragment(): PairInput | undefined {
  return initialPairFragment.consume();
}

/** Keep unpaired users and incoming pair links on the pairing route. */
export function shouldRedirectToPair(hasPairedMachine: boolean): boolean {
  return initialPairFragment.shouldRedirectToPair(hasPairedMachine);
}
