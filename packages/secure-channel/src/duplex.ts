export interface DuplexSocket {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}
