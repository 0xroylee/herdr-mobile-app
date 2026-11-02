import type { HcEvent, Status, SubscribeResult, Terminal } from "@herdr-mobile/protocol";

export type TerminalTable = Readonly<Record<string, Terminal>>;
export type MutableTerminalTable = Record<string, Terminal>;

type Snapshot = SubscribeResult | readonly Terminal[] | { terminals: readonly Terminal[] };

/** Replace the terminal table with the snapshot returned by subscribe or missed. */
export function applySnapshot(snapshot: Snapshot): MutableTerminalTable {
  const records = isTerminalList(snapshot) ? snapshot : snapshot.terminals;
  return Object.fromEntries(
    records.filter(isTerminal).map((terminal) => [terminal.address, terminal]),
  );
}

function isTerminalList(snapshot: Snapshot): snapshot is readonly Terminal[] {
  return Array.isArray(snapshot);
}

/** Apply one event-table update without mutating the current table. */
export function applyEvent(
  terminals: TerminalTable,
  event: HcEvent,
  now: number,
): MutableTerminalTable {
  if (event.type === "missed") {
    const data = asObject(event.data);
    const snapshot = data?.terminals;
    return Array.isArray(snapshot) ? applySnapshot(snapshot.filter(isTerminal)) : { ...terminals };
  }

  if (event.type === "created" || event.type === "restarted") {
    const record = asTerminal(event.data);
    return record === undefined ? { ...terminals } : { ...terminals, [record.address]: record };
  }

  const address = event.terminal;
  if (address === undefined) return { ...terminals };
  const terminal = terminals[address];
  if (event.type === "foreground" && event.data === null && terminal !== undefined) {
    return { ...terminals, [address]: { ...terminal, foreground: null } };
  }
  const data = asObject(event.data);
  if (data === undefined) return { ...terminals };
  if (terminal === undefined) {
    if (event.type === "labels") {
      const record = asTerminal(data.record);
      return record === undefined ? { ...terminals } : { ...terminals, [record.address]: record };
    }
    return { ...terminals };
  }

  switch (event.type) {
    case "lost": {
      const { foreground: _foreground, ...current } = terminal;
      return {
        ...terminals,
        [address]: {
          ...current,
          reason: nullableString(data.reason),
          exit_code: nullableNumber(data.exit_code),
          signal: nullableNumber(data.signal),
          finished_ms: null,
          pid: null,
        },
      };
    }
    case "keep":
      return typeof data.keep === "boolean"
        ? { ...terminals, [address]: { ...terminal, keep: data.keep } }
        : { ...terminals };
    case "finished": {
      const { foreground: _foreground, ...current } = terminal;
      return {
        ...terminals,
        [address]: {
          ...current,
          state: "finished",
          reason: nullableString(data.reason),
          exit_code: nullableNumber(data.exit_code),
          signal: nullableNumber(data.signal),
          finished_ms: nullableNumber(data.finished_ms),
        },
      };
    }
    case "removed": {
      const next = { ...terminals };
      delete next[address];
      return next;
    }
    case "status": {
      const records = asStatusMap(data.records);
      if (records === undefined || typeof data.reported !== "boolean") return { ...terminals };
      const status = data.status === null ? null : asStatus(data.status);
      if (data.status !== null && status === undefined) return { ...terminals };
      const statusMs = terminal.status?.state === status?.state ? terminal.status_ms : now;
      return {
        ...terminals,
        [address]: { ...terminal, status, status_ms: statusMs, records, reported: data.reported },
      };
    }
    case "turn":
      return typeof data.turn === "number" && Number.isFinite(data.turn)
        ? { ...terminals, [address]: { ...terminal, turn: data.turn } }
        : { ...terminals };
    case "title":
      return typeof data.title === "string"
        ? { ...terminals, [address]: { ...terminal, title: data.title } }
        : { ...terminals };
    case "labels": {
      const labels = asStringMap(data.labels);
      if (labels === undefined) return { ...terminals };
      return { ...terminals, [address]: { ...terminal, labels } };
    }
    case "size":
      return typeof data.cols === "number" && typeof data.rows === "number"
        ? { ...terminals, [address]: { ...terminal, cols: data.cols, rows: data.rows } }
        : { ...terminals };
    case "foreground": {
      if (data === null) return { ...terminals, [address]: { ...terminal, foreground: null } };
      const foreground = asObject(data);
      if (
        foreground === undefined ||
        typeof foreground.pid !== "number" ||
        typeof foreground.name !== "string" ||
        !Array.isArray(foreground.argv) ||
        !foreground.argv.every((argument) => typeof argument === "string") ||
        typeof foreground.cwd !== "string"
      ) {
        return { ...terminals };
      }
      return {
        ...terminals,
        [address]: { ...terminal, foreground: foreground as unknown as Terminal["foreground"] },
      };
    }
    default:
      return { ...terminals };
  }
}

function isTerminal(value: unknown): value is Terminal {
  const record = asObject(value);
  return (
    record !== undefined &&
    typeof record.address === "string" &&
    Array.isArray(record.argv) &&
    record.argv.every((argument) => typeof argument === "string") &&
    typeof record.cols === "number" &&
    typeof record.created_ms === "number" &&
    typeof record.cwd === "string" &&
    asStringMap(record.labels) !== undefined &&
    typeof record.rows === "number" &&
    typeof record.screen === "string" &&
    typeof record.state === "string"
  );
}

function asTerminal(value: unknown): Terminal | undefined {
  return isTerminal(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStatus(value: unknown): Status | undefined {
  const record = asObject(value);
  return record !== undefined && typeof record.state === "string"
    ? (record as unknown as Status)
    : undefined;
}

function asStatusMap(value: unknown): Record<string, Status> | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const statuses: Record<string, Status> = {};
  for (const [key, entry] of Object.entries(record)) {
    const status = asStatus(entry);
    if (status === undefined) return undefined;
    statuses[key] = status;
  }
  return statuses;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") return undefined;
    strings[key] = entry;
  }
  return strings;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" || value === null ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" || value === null ? value : null;
}
