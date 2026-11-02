import type { Status } from "@herdr-mobile/protocol";
import { markSent, type SentState, updateSent } from "../../model/sent.ts";

/** Owns the transient Sent lifetime and permanently clears it on working or expiry. */
export class SentController {
  private status: Status | null | undefined;
  private sent: SentState | undefined;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): SentState | undefined => this.sent;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  updateStatus(status: Status | null | undefined, now: number): void {
    this.status = status;
    this.setSent(updateSent(this.sent, status, now));
  }

  mark(status: Status | null | undefined, now: number): void {
    this.updateStatus(status, now);
    if (status?.state === "working") return;
    this.setSent(markSent(now));
  }

  expire(now: number): void {
    this.setSent(updateSent(this.sent, this.status, now));
  }

  private setSent(next: SentState | undefined): void {
    if (this.sent?.sentAt === next?.sentAt) return;
    this.sent = next;
    for (const listener of this.listeners) listener();
  }
}
