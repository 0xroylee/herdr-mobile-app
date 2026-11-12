import { describe, expect, test } from "bun:test";
import {
  createWebSocketBridgeHandlers,
  forwardedHeaders,
  parseStandInEdgeArgs,
  upstreamHttpRequest,
  upstreamWebSocketRequest,
} from "./stand-in-edge.ts";

describe("stand-in edge modes", () => {
  test("defaults to a loopback cloudflared stand-in for the secure port", () => {
    const config = parseStandInEdgeArgs([]);
    expect(config).toEqual({
      listenPort: 9443,
      targetPort: 8788,
      header: { name: "Cf-Connecting-Ip", value: "127.0.0.1" },
    });
    expect(forwardedHeaders(new Headers(), config).get("Cf-Connecting-Ip")).toBe("127.0.0.1");
  });

  test("accepts explicit ports and owner for the direct-route stand-in", () => {
    const config = parseStandInEdgeArgs([
      "--serve",
      "8791",
      "--to",
      "8790",
      "--owner",
      "owner@example.com",
    ]);
    expect(config).toEqual({
      listenPort: 8791,
      targetPort: 8790,
      header: { name: "Tailscale-User-Login", value: "owner@example.com" },
    });
  });

  test("preserves HTTP path, query, method and body while setting the edge header", async () => {
    const config = parseStandInEdgeArgs([]);
    const request = new Request("http://127.0.0.1:9443/api/health?full=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "r-1" },
      body: "{}",
    });
    const forwarded = upstreamHttpRequest(request, config);

    expect(forwarded.url).toBe("http://127.0.0.1:8788/api/health?full=1");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("cf-connecting-ip")).toBe("127.0.0.1");
    expect(forwarded.headers.get("x-request-id")).toBe("r-1");
    expect(await forwarded.text()).toBe("{}");
  });

  test("forwards websocket target and protocols with the Tailscale identity header", () => {
    const config = parseStandInEdgeArgs([
      "--serve",
      "8791",
      "--to",
      "8790",
      "--owner",
      "owner@example.com",
    ]);
    const forwarded = upstreamWebSocketRequest(
      new Request("http://127.0.0.1:8791/ws?trace=1", {
        headers: { "Sec-WebSocket-Protocol": "herdr, v1", "X-Trace": "t1" },
      }),
      config,
    );

    expect(forwarded.url).toBe("ws://127.0.0.1:8790/ws?trace=1");
    expect(forwarded.protocols).toEqual(["herdr", "v1"]);
    expect(forwarded.headers.get("tailscale-user-login")).toBe("owner@example.com");
    expect(forwarded.headers.has("sec-websocket-key")).toBe(false);
    expect(forwarded.headers.has("x-trace")).toBe(true);
  });

  test("bridges WebSocket frames in both directions and queues until upstream opens", () => {
    const requests: string[] = [];
    const upstream = new FakeUpstream();
    const handlers = createWebSocketBridgeHandlers((request) => {
      requests.push(request.url);
      return upstream as unknown as WebSocket;
    });
    const downstreamState = {
      data: {
        request: {
          url: "ws://127.0.0.1:8788/ws",
          headers: new Headers(),
          protocols: [],
        },
        queue: [] as Array<string | ArrayBuffer | Blob>,
        closed: false,
      },
      sent: [] as Array<string | ArrayBuffer | Blob>,
      closeCode: 0,
      closeReason: "",
      send(message: string | ArrayBuffer | Blob): void {
        this.sent.push(message);
      },
      close(code: number, reason: string): void {
        this.closeCode = code;
        this.closeReason = reason;
      },
    };
    const downstream = downstreamState as unknown as Parameters<typeof handlers.open>[0];

    handlers.open(downstream);
    handlers.message(downstream, new Uint8Array([1, 2, 3]));
    expect(upstream.sent).toHaveLength(0);
    upstream.open();
    expect(requests).toEqual(["ws://127.0.0.1:8788/ws"]);
    expect(upstream.sent).toHaveLength(1);
    expect(new Uint8Array(upstream.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

    upstream.message("reply");
    expect(downstreamState.sent).toEqual(["reply"]);
    upstream.close(1000, "done");
    expect(downstreamState.closeCode).toBe(1000);
  });

  test("rejects missing or invalid direct-mode arguments", () => {
    expect(() => parseStandInEdgeArgs(["--serve", "0", "--to", "8787", "--owner", "a"])).toThrow(
      "--serve must be an integer from 1 to 65535",
    );
    expect(() => parseStandInEdgeArgs(["--serve", "9443"])).toThrow("--to requires a direct port");
  });
});

class FakeUpstream extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readonly sent: Array<string | ArrayBuffer | Blob> = [];

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(typeof data === "string" || data instanceof Blob ? data : (data as ArrayBuffer));
  }
  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  message(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
