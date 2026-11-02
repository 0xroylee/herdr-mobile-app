import type { KeyQueue, TerminalKeySender } from "./key-queue.ts";

export interface PromptAnswerSnapshot {
  answering: boolean;
}

/** Guards only prompt answers while sharing the key queue's ordering with ordinary keys. */
export class PromptAnswer {
  private inFlight: Promise<boolean> | undefined;
  private snapshot: PromptAnswerSnapshot = { answering: false };
  private readonly listeners = new Set<() => void>();
  private readonly queue: KeyQueue;

  constructor(queue: KeyQueue) {
    this.queue = queue;
  }

  getSnapshot = (): PromptAnswerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  answer(keys: readonly string[], sender: TerminalKeySender): Promise<boolean> {
    if (this.inFlight) return Promise.resolve(false);

    const answer = this.queue.send(keys, sender);
    this.inFlight = answer;
    this.setAnswering(true);
    return answer.finally(() => {
      if (this.inFlight !== answer) return;
      this.inFlight = undefined;
      this.setAnswering(false);
    });
  }

  private setAnswering(answering: boolean): void {
    if (this.snapshot.answering === answering) return;
    this.snapshot = { answering };
    for (const listener of this.listeners) listener();
  }
}
