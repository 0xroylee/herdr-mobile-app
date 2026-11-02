/** WebSocket messages are binary after the bridge authentication reply. */
export interface Socket {
  onopen: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => Socket;

/** Create the platform WebSocket without making the connection manager depend on its globals. */
export function webSocketFactory(url: string): Socket {
  const webSocket = new WebSocket(url);
  webSocket.binaryType = "arraybuffer";

  const socket: Socket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      webSocket.send(data);
    },
    close(code, reason) {
      webSocket.close(code, reason);
    },
  };

  webSocket.onopen = () => socket.onopen?.();
  webSocket.onmessage = (event) => socket.onmessage?.(event.data);
  webSocket.onclose = (event) => socket.onclose?.({ code: event.code, reason: event.reason });
  webSocket.onerror = () => socket.onerror?.();

  return socket;
}
