import type { Status } from "@herdr-mobile/protocol";

export type EffectiveState = "blocked" | "done" | "working" | "idle";

/** Highest urgency first. The same order is used for list sections and groups. */
export const urgencyOrder: readonly EffectiveState[] = ["blocked", "done", "working", "idle"];

const urgencyRank: Record<EffectiveState, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
};

/** Convert a program status into the four states the app presents. */
export function effectiveState(
  status: Status | null | undefined,
  options: { seen?: boolean; terminalState?: string } = {},
): EffectiveState {
  let state: EffectiveState;
  switch (status?.state) {
    case "blocked":
    case "error":
      state = "blocked";
      break;
    case "done":
      state = "done";
      break;
    case "working":
      state = "working";
      break;
    case "idle":
      state = "idle";
      break;
    default:
      state = "idle";
  }
  return state === "done" && options.seen === true ? "idle" : state;
}

/** Compare two states in urgency order; a negative result puts left first. */
export function compareUrgency(left: EffectiveState, right: EffectiveState): number {
  return urgencyRank[left] - urgencyRank[right];
}

/** Return the most urgent state in a collection, or idle for an empty one. */
export function mostUrgent(states: readonly EffectiveState[]): EffectiveState {
  return states.reduce(
    (mostUrgentState, state) =>
      compareUrgency(state, mostUrgentState) < 0 ? state : mostUrgentState,
    "idle",
  );
}
