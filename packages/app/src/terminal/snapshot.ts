export type TerminalColor =
  | { readonly kind: "default" }
  | { readonly kind: "ansi"; readonly index: number }
  | { readonly kind: "rgb"; readonly hex: string };

export interface ScreenRun {
  readonly text: string;
  readonly fg: TerminalColor;
  readonly bg: TerminalColor;
  readonly bold: boolean;
  readonly inverse: boolean;
}

export type ScreenRow = readonly ScreenRun[];

export interface ScreenCursor {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

export interface ScreenSnapshot {
  readonly cols: number;
  readonly rows: readonly ScreenRow[];
  readonly cursor: ScreenCursor;
}

const DEFAULT_COLOR: TerminalColor = { kind: "default" };

function sameColor(left: TerminalColor, right: TerminalColor): boolean {
  if (left.kind === "default") return right.kind === "default";
  if (left.kind === "ansi") return right.kind === "ansi" && left.index === right.index;
  return right.kind === "rgb" && left.hex === right.hex;
}

function sameStyle(left: ScreenRun, right: ScreenRun): boolean {
  return (
    sameColor(left.fg, right.fg) &&
    sameColor(left.bg, right.bg) &&
    left.bold === right.bold &&
    left.inverse === right.inverse
  );
}

export function coalesceRuns(runs: readonly ScreenRun[]): ScreenRun[] {
  const coalesced: ScreenRun[] = [];

  for (const run of runs) {
    if (run.text.length === 0) continue;

    const previous = coalesced[coalesced.length - 1];
    if (previous && sameStyle(previous, run)) {
      coalesced[coalesced.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      coalesced.push(run);
    }
  }

  return coalesced;
}

export function screenTextRows(snapshot: ScreenSnapshot): string[] {
  return snapshot.rows.map((row) =>
    row
      .map((run) => run.text)
      .join("")
      .replace(/[ \t]+$/u, ""),
  );
}

export const defaultTerminalColor = DEFAULT_COLOR;
