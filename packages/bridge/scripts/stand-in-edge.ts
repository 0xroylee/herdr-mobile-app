interface ForwardHeader {
  name: "Cf-Connecting-Ip" | "Tailscale-User-Login";
  value: string;
}

export interface StandInEdgeConfig {
  listenPort: number;
  targetPort: number;
  header: ForwardHeader;
}

interface EdgeSocketData {
  request: UpstreamWebSocketRequest;
  upstream?: WebSocket;
  queue: Array<string | ArrayBuffer | Blob>;
  closed: boolean;
}

export interface UpstreamWebSocketRequest {
  url: string;
  headers: Headers;
  protocols: string[];
}

function parsePort(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer from 1 to 65535`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

/** Parses the Cloudflare stand-in defaults or the Tailscale Serve stand-in mode. */
export function parseStandInEdgeArgs(args: readonly string[]): StandInEdgeConfig {
  if (args.length === 0) {
    return {
      listenPort: 9443,
      targetPort: 8788,
      header: { name: "Cf-Connecting-Ip", value: "127.0.0.1" },
    };
  }
  if (args[0] !== "--serve") {
    throw new Error(
      "usage: stand-in-edge.ts [--serve <listen-port> --to <direct-port> --owner <login>]",
    );
  }

  let listenPort: number | undefined;
  let targetPort: number | undefined;
  let owner: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--serve") listenPort = parsePort(value, "--serve");
    else if (flag === "--to") targetPort = parsePort(value, "--to");
    else if (flag === "--owner") owner = value.trim();
    else throw new Error(`unknown option: ${flag}`);
    index++;
  }
  if (listenPort === undefined) throw new Error("--serve requires a listen port");
  if (targetPort === undefined) throw new Error("--to requires a direct port");
  if (!owner) throw new Error("--owner requires a login");
  return {
    listenPort,
    targetPort,
    header: { name: "Tailscale-User-Login", value: owner },
  };
}

export function forwardedHeaders(headers: Headers, config: StandInEdgeConfig): Headers {
  const result = new Headers(headers);
  result.delete("host");
  result.delete("connection");
  result.delete("upgrade");
  result.set(config.header.name, config.header.value);
  return result;
}

export function upstreamHttpRequest(request: Request, config: StandInEdgeConfig): Request {
  const incoming = new URL(request.url);
  const destination = new URL(`http://127.0.0.1:${config.targetPort}`);
  destination.pathname = incoming.pathname;
  destination.search = incoming.search;
  const headers = forwardedHeaders(request.headers, config);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
  }
  return new Request(destination.toString(), init);
}

export function upstreamWebSocketRequest(
  request: Request,
  config: StandInEdgeConfig,
): UpstreamWebSocketRequest {
  const incoming = new URL(request.url);
  const destination = new URL(`ws://127.0.0.1:${config.targetPort}`);
  destination.pathname = incoming.pathname;
  destination.search = incoming.search;
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  const headers = forwardedHeaders(request.headers, config);
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
  ]) {
    headers.delete(name);
  }
  return {
    url: destination.toString(),
    headers,
    protocols: protocolHeader
      ? protocolHeader
          .split(",")
          .map((protocol) => protocol.trim())
          .filter(Boolean)
      : [],
  };
}

type UpstreamSocketFactory = (request: UpstreamWebSocketRequest) => WebSocket;

interface BunWebSocketConstructor {
  new (url: string, options: { headers: Headers; protocols?: string[] }): WebSocket;
}

function connectUpstream(request: UpstreamWebSocketRequest): WebSocket {
  const Constructor = globalThis.WebSocket as unknown as BunWebSocketConstructor;
  return new Constructor(request.url, {
    headers: request.headers,
    ...(request.protocols.length === 0 ? {} : { protocols: request.protocols }),
  });
}

/** Returns the Bun WebSocket adapter callbacks; inject `connect` for local tests. */
export function createWebSocketBridgeHandlers(connect: UpstreamSocketFactory = connectUpstream) {
  return {
    open(ws: Bun.ServerWebSocket<EdgeSocketData>) {
      const request = ws.data.request;
      let upstream: WebSocket;
      try {
        upstream = connect(request);
      } catch {
        ws.data.closed = true;
        ws.close(1011, "upstream connection failed");
        return;
      }
      ws.data.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.addEventListener("open", () => {
        for (const message of ws.data.queue.splice(0)) upstream.send(message);
      });
      upstream.addEventListener("message", (event) => {
        if (ws.data.closed) return;
        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((bytes) => {
            if (!ws.data.closed) ws.send(bytes);
          });
        } else if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
          ws.send(event.data);
        } else if (ArrayBuffer.isView(event.data)) {
          const bytes = new Uint8Array(event.data.byteLength);
          bytes.set(
            new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
          );
          ws.send(bytes.buffer);
        }
      });
      upstream.addEventListener("close", (event) => {
        if (ws.data.closed) return;
        ws.data.closed = true;
        ws.close(event.code, event.reason);
      });
      upstream.addEventListener("error", () => {
        if (ws.data.closed) return;
        ws.data.closed = true;
        ws.close(1011, "upstream connection failed");
      });
    },
    message(ws: Bun.ServerWebSocket<EdgeSocketData>, message: string | Uint8Array) {
      const forwarded = typeof message === "string" ? message : Uint8Array.from(message).buffer;
      const upstream = ws.data.upstream;
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        ws.data.queue.push(forwarded);
        return;
      }
      upstream.send(forwarded);
    },
    close(ws: Bun.ServerWebSocket<EdgeSocketData>, code: number, reason: string) {
      ws.data.closed = true;
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState < WebSocket.CLOSING) {
        upstream.close(code, reason);
      }
    },
  };
}

export async function startStandInEdge(
  config: StandInEdgeConfig,
): Promise<Bun.Server<EdgeSocketData>> {
  const websocket = createWebSocketBridgeHandlers();
  return Bun.serve<EdgeSocketData>({
    hostname: "127.0.0.1",
    port: config.listenPort,
    async fetch(request, server) {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const target = upstreamWebSocketRequest(request, config);
        const data: EdgeSocketData = { request: target, queue: [], closed: false };
        if (!server.upgrade(request, { data })) return new Response(null, { status: 400 });
        return undefined;
      }
      try {
        return await fetch(upstreamHttpRequest(request, config));
      } catch {
        return new Response("upstream unavailable", { status: 502 });
      }
    },
    websocket,
  });
}

if (import.meta.main) {
  try {
    const config = parseStandInEdgeArgs(Bun.argv.slice(2));
    const server = await startStandInEdge(config);
    console.log(`Stand-in edge listening on 127.0.0.1:${server.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
