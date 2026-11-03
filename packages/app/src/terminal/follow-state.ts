export const PROGRAMMATIC_SCROLL_TOLERANCE = 0.5;

const MAX_PENDING_PROGRAMMATIC_OFFSETS = 8;

export interface TerminalFollowState {
  followsFocus: boolean;
  automaticOffset: number | null;
  cellHeight: number;
  lastObservedOffset: number | null;
  pendingProgrammaticOffsets: readonly number[];
  clampedOffset: number | null;
  dragActive: boolean;
  dragLeftFocus: boolean;
}

export interface FollowTransition {
  state: TerminalFollowState;
  shouldScroll: boolean;
}

export function createTerminalFollowState(): TerminalFollowState {
  return {
    followsFocus: true,
    automaticOffset: null,
    cellHeight: 0,
    lastObservedOffset: null,
    pendingProgrammaticOffsets: [],
    clampedOffset: null,
    dragActive: false,
    dragLeftFocus: false,
  };
}

function isNear(left: number, right: number): boolean {
  return Math.abs(left - right) <= PROGRAMMATIC_SCROLL_TOLERANCE;
}

function isAtFocus(state: TerminalFollowState, offset: number): boolean {
  return (
    state.automaticOffset !== null && Math.abs(offset - state.automaticOffset) <= state.cellHeight
  );
}

function queueProgrammaticOffset(pending: readonly number[], offset: number): readonly number[] {
  return [...pending, offset].slice(-MAX_PENDING_PROGRAMMATIC_OFFSETS);
}

export function setAutomaticScrollTarget(
  state: TerminalFollowState,
  offset: number,
  cellHeight: number,
): FollowTransition {
  const nextState = { ...state, automaticOffset: offset, cellHeight };
  return { state: nextState, shouldScroll: nextState.followsFocus };
}

export function setProgrammaticScrollOffset(
  state: TerminalFollowState,
  offset: number,
): TerminalFollowState {
  return {
    ...state,
    pendingProgrammaticOffsets: queueProgrammaticOffset(state.pendingProgrammaticOffsets, offset),
  };
}

export function setFollowGeometry(
  state: TerminalFollowState,
  input: { offset: number; cellHeight: number; maxOffset: number },
): FollowTransition {
  const clampedPreviousOffset = Math.max(
    0,
    Math.min(input.maxOffset, state.lastObservedOffset ?? 0),
  );
  const clampedOffset =
    state.lastObservedOffset === null || !isNear(clampedPreviousOffset, state.lastObservedOffset)
      ? clampedPreviousOffset
      : null;
  const stateWithGeometry: TerminalFollowState = {
    ...state,
    followsFocus: true,
    automaticOffset: input.offset,
    cellHeight: input.cellHeight,
    clampedOffset,
    dragActive: false,
    dragLeftFocus: false,
  };

  return {
    state: stateWithGeometry,
    shouldScroll: true,
  };
}

function resumeAtFocus(
  state: TerminalFollowState,
  offset: number,
  dragEnded: boolean,
): TerminalFollowState {
  if (!isAtFocus(state, offset)) {
    return state.dragActive ? { ...state, dragLeftFocus: true } : { ...state, followsFocus: false };
  }

  if (dragEnded || !state.dragActive || state.dragLeftFocus) {
    return { ...state, followsFocus: true, dragLeftFocus: false };
  }
  return state;
}

export function observeScrollOffset(
  state: TerminalFollowState,
  offset: number,
): TerminalFollowState {
  const observedState = { ...state, lastObservedOffset: offset };

  if (state.clampedOffset !== null && isNear(offset, state.clampedOffset)) {
    return { ...observedState, clampedOffset: null };
  }

  const matchedPendingIndex = state.pendingProgrammaticOffsets.findIndex((pending) =>
    isNear(offset, pending),
  );
  if (matchedPendingIndex >= 0) {
    const matchedState = {
      ...observedState,
      pendingProgrammaticOffsets: state.pendingProgrammaticOffsets.slice(matchedPendingIndex + 1),
    };
    return isAtFocus(matchedState, offset) && !matchedState.followsFocus
      ? resumeAtFocus(matchedState, offset, false)
      : matchedState;
  }

  return resumeAtFocus(observedState, offset, false);
}

export function beginTerminalDrag(state: TerminalFollowState): TerminalFollowState {
  return {
    ...state,
    followsFocus: false,
    dragActive: true,
    dragLeftFocus: false,
  };
}

export function endTerminalDrag(state: TerminalFollowState, offset: number): TerminalFollowState {
  const endedState = { ...state, dragActive: false, lastObservedOffset: offset };
  const matchedPendingIndex = state.pendingProgrammaticOffsets.findIndex((pending) =>
    isNear(offset, pending),
  );
  const stateWithoutMatchedScroll =
    matchedPendingIndex >= 0
      ? {
          ...endedState,
          pendingProgrammaticOffsets: state.pendingProgrammaticOffsets.slice(
            matchedPendingIndex + 1,
          ),
        }
      : endedState;
  return resumeAtFocus(stateWithoutMatchedScroll, offset, true);
}
