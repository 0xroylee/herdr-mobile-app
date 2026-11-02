import type { Status } from "@herdr-mobile/protocol";

export const SENT_TIMEOUT_MS = 20_000;

export interface SentState {
  sentAt: number;
}

export function markSent(now: number): SentState {
  return { sentAt: now };
}

/** A working report or the 20-second deadline clears the transient sent state. */
export function updateSent(
  sent: SentState | undefined,
  status: Status | null | undefined,
  now: number,
): SentState | undefined {
  if (sent === undefined || status?.state === "working" || now - sent.sentAt >= SENT_TIMEOUT_MS) {
    return undefined;
  }
  return sent;
}

export function isSent(
  sent: SentState | undefined,
  status: Status | null | undefined,
  now: number,
): boolean {
  return updateSent(sent, status, now) !== undefined;
}
