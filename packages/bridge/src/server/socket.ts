/** The binary WebSocket operations a bridge session needs. */
export interface Socket {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: () => void): void;
}
