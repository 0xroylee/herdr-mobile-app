export type TerminalKeySender = (keys: readonly string[]) => Promise<boolean>;

/** Sends every accepted key sequence in order and isolates each sender failure. */
export class KeyQueue {
  private tail: Promise<void> = Promise.resolve();

  send(keys: readonly string[], sender: TerminalKeySender): Promise<boolean> {
    const sequence = [...keys];
    const result = this.tail.then(async () => {
      try {
        return await sender(sequence);
      } catch {
        return false;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
