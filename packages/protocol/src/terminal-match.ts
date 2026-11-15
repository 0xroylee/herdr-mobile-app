import type { Terminal } from "./generated/hc-api.ts";

export interface TerminalMatchCriteria {
  program: string;
  folder: string;
  spaceId?: string;
  withinMs?: number;
}

const DEFAULT_WITHIN_MS = 15_000;

/** Return the newest live match; for tied creation times, keep the first input terminal. */
export function matchTerminal(
  terminals: readonly Terminal[],
  criteria: TerminalMatchCriteria,
  now: number,
): Terminal | undefined {
  const withinMs = criteria.withinMs ?? DEFAULT_WITHIN_MS;
  let newest: Terminal | undefined;

  for (const terminal of terminals) {
    const age = now - terminal.created_ms;
    if (
      terminal.state !== "live" ||
      terminal.argv[0] !== criteria.program ||
      terminal.cwd !== criteria.folder ||
      (criteria.spaceId !== undefined && terminal.labels["herdr.space"] !== criteria.spaceId) ||
      age < 0 ||
      age > withinMs
    ) {
      continue;
    }

    if (newest === undefined || terminal.created_ms > newest.created_ms) newest = terminal;
  }

  return newest;
}
