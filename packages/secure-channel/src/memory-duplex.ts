import type { DuplexSocket } from "./duplex.ts";

export type MemoryDuplexDirection = "first-to-second" | "second-to-first";

export interface MemoryDuplexHooks {
  /**
   * Return `null` to drop a frame, multiple frames to duplicate it, or an
   * ordered list to release held frames in a different order. Returning
   * `undefined` delivers the original frame once.
   */
  transform?: (
    direction: MemoryDuplexDirection,
    bytes: Uint8Array,
    index: number,
  ) => readonly Uint8Array[] | null | undefined;
}

/** Builds two in-memory binary sockets for deterministic channel tests. */
export function createMemoryDuplexPair(hooks?: MemoryDuplexHooks): [DuplexSocket, DuplexSocket] {
  const firstMessages: Array<(bytes: Uint8Array) => void> = [];
  const secondMessages: Array<(bytes: Uint8Array) => void> = [];
  const firstCloses: Array<(code: number, reason: string) => void> = [];
  const secondCloses: Array<(code: number, reason: string) => void> = [];
  let closed = false;
  let closeEvent: { code: number; reason: string } | undefined;
  let firstToSecondIndex = 0;
  let secondToFirstIndex = 0;

  const notifyClose = (
    listeners: Array<(code: number, reason: string) => void>,
    event: { code: number; reason: string },
  ) => {
    for (const listener of [...listeners]) {
      try {
        listener(event.code, event.reason);
      } catch {
        // One test listener should not prevent the other endpoint from closing.
      }
    }
  };

  const makeEndpoint = (
    messages: Array<(bytes: Uint8Array) => void>,
    closes: Array<(code: number, reason: string) => void>,
    peerMessages: Array<(bytes: Uint8Array) => void>,
    peerCloses: Array<(code: number, reason: string) => void>,
    direction: MemoryDuplexDirection,
  ): DuplexSocket => ({
    send(bytes) {
      if (closed) throw new Error("memory socket is closed");
      const index = direction === "first-to-second" ? firstToSecondIndex++ : secondToFirstIndex++;
      const snapshot = copyFrame(bytes);
      const transformed = hooks?.transform?.(direction, snapshot as Uint8Array, index);
      const frames = transformed === undefined ? [snapshot] : (transformed ?? []);
      for (const frame of frames) {
        const delivered = copyFrame(frame);
        for (const listener of [...peerMessages]) {
          try {
            listener(delivered as Uint8Array);
          } catch {
            // The peer's transport callback owns protocol errors.
          }
        }
      }
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      closeEvent = { code, reason };
      notifyClose(closes, closeEvent);
      notifyClose(peerCloses, closeEvent);
    },
    onMessage(listener) {
      messages.push(listener);
    },
    onClose(listener) {
      if (closeEvent) {
        listener(closeEvent.code, closeEvent.reason);
      } else {
        closes.push(listener);
      }
    },
  });

  return [
    makeEndpoint(firstMessages, firstCloses, secondMessages, secondCloses, "first-to-second"),
    makeEndpoint(secondMessages, secondCloses, firstMessages, firstCloses, "second-to-first"),
  ];
}

function copyFrame(bytes: Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes.slice();
  // Preserve malformed non-binary frames so the handshake rejects them.
  return bytes as unknown as Uint8Array;
}
