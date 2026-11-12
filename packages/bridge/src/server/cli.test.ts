import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../prototype/deadline.ts";
import { runCli } from "./cli.ts";

const env = { HOME: "/Users/bridge", PATH: "/usr/bin:/bin" };
const PUBLIC_KEY = base64UrlBytes(new Uint8Array(32).fill(7));
const SECRET_KEY = base64UrlBytes(new Uint8Array(32).fill(8));

function success(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("herdr-bridge CLI", () => {
  test("uses the machine name in the link when --name changes the paired device name", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const output: string[] = [];
    const result = await runCli(["pair", "--watch", "--name", "Desk phone"], {
      env,
      adminFetch: async (_socketPath, path, init) => {
        calls.push({ path, init });
        if (path === "/status") {
          return success({
            publicUrl: "https://mac.tailnet.ts.net",
            machine: { name: "Review Mac" },
            bridgeKey: PUBLIC_KEY,
            secure: {},
          });
        }
        return success({ code: "ABCDEFGH", expiresAt: 1_600_000 }, 201);
      },
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(`ERR ${text}`),
    });

    expect(result).toBe(0);
    expect(calls.map(({ path }) => path)).toEqual(["/status", "/pair-code"]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      role: "watch",
      name: "Desk phone",
    });
    const link = output[0]?.replace("Pair link: ", "");
    const parsed = new URL(link ?? "");
    const encoded = parsed.hash.slice("#pair=".length).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    expect(JSON.parse(atob(padded))).toEqual({
      v: 2,
      u: "https://mac.tailnet.ts.net",
      k: PUBLIC_KEY,
      c: "ABCDEFGH",
      n: "Review Mac",
    });
    expect(output.join("\n")).not.toContain(SECRET_KEY);
    expect(output[1]).toContain("█");
  });

  test("includes the machine name by default when the secure route is configured", async () => {
    const output: string[] = [];
    const result = await runCli(["pair"], {
      env,
      adminFetch: async (_socketPath, path) =>
        path === "/status"
          ? success({
              publicUrl: "https://mac.tailnet.ts.net",
              machine: { name: "Review Mac" },
              routes: { direct: "https://mac.tailnet.ts.net" },
              bridgeKey: PUBLIC_KEY,
              secure: { port: 9443, url: "https://bridge.example.test" },
            })
          : success({ code: "ABCDEFGH", expiresAt: 1_600_000 }, 201),
      stdout: (text) => output.push(text),
    });

    expect(result).toBe(0);
    const link = output[0]?.replace("Pair link: ", "");
    const parsed = new URL(link ?? "");
    expect(parsed.origin).toBe("https://bridge.example.test");
    const encoded = parsed.hash.slice("#pair=".length).replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    expect(payload).toEqual({
      v: 2,
      u: "https://mac.tailnet.ts.net",
      s: "https://bridge.example.test",
      k: PUBLIC_KEY,
      c: "ABCDEFGH",
      n: "Review Mac",
    });
  });

  test("notes when the secure port is configured without an advertised URL", async () => {
    const output: string[] = [];
    const result = await runCli(["pair"], {
      env,
      adminFetch: async (_socketPath, path) =>
        path === "/status"
          ? success({
              publicUrl: "https://mac.tailnet.ts.net",
              machine: { name: "Review Mac" },
              bridgeKey: PUBLIC_KEY,
              secure: { port: 9443 },
            })
          : success({ code: "ABCDEFGH", expiresAt: 1_600_000 }, 201),
      stdout: (text) => output.push(text),
    });

    expect(result).toBe(0);
    expect(output[0]).toContain("Secure listener port 9443 is configured");
    expect(output[0]).toContain("no secure URL is set");
    expect(output[1]).toContain("Pair link: https://mac.tailnet.ts.net/#pair=");
  });

  test("reads the quick-tunnel hostname from injected cloudflared metrics and sets it", async () => {
    const output: string[] = [];
    const adminCalls: { path: string; method: string; body?: string }[] = [];
    const metricsCalls: string[] = [];
    const result = await runCli(["secure", "url", "--from-cloudflared"], {
      env,
      adminFetch: async (_socketPath, path, init = {}) => {
        adminCalls.push({ path, method: init.method ?? "GET", body: init.body?.toString() });
        return success({ url: "https://calm-otter.trycloudflare.com" });
      },
      fetch: async (input) => {
        metricsCalls.push(String(input));
        return success({ hostname: "calm-otter.trycloudflare.com" });
      },
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(`ERR ${text}`),
    });

    expect(result).toBe(0);
    expect(metricsCalls).toEqual(["http://127.0.0.1:20241/quicktunnel"]);
    expect(adminCalls).toEqual([
      {
        path: "/secure-url",
        method: "PUT",
        body: JSON.stringify({ url: "https://calm-otter.trycloudflare.com" }),
      },
    ]);
    expect(output).toEqual(["Secure URL set to https://calm-otter.trycloudflare.com"]);
  });

  test("accepts an explicit metrics address and sets or clears a manual secure URL", async () => {
    const output: string[] = [];
    const adminCalls: { path: string; method: string; body?: string }[] = [];
    const metricsCalls: string[] = [];
    const adminFetch = async (_socketPath: string, path: string, init: RequestInit = {}) => {
      adminCalls.push({ path, method: init.method ?? "GET", body: init.body?.toString() });
      return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : success({ url: "http://192.168.1.5:9443" });
    };

    expect(
      await runCli(["secure", "url", "--from-cloudflared", "localhost:80"], {
        env,
        adminFetch,
        fetch: async (input) => {
          metricsCalls.push(String(input));
          return success({ hostname: "calm-otter.trycloudflare.com" });
        },
        stdout: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(
      await runCli(["secure", "url", "http://192.168.1.5:9443/"], {
        env,
        adminFetch,
        stdout: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(
      await runCli(["secure", "url", "--clear"], {
        env,
        adminFetch,
        stdout: (text) => output.push(text),
      }),
    ).toBe(0);

    expect(metricsCalls).toEqual(["http://localhost:80/quicktunnel"]);
    expect(adminCalls).toEqual([
      {
        path: "/secure-url",
        method: "PUT",
        body: JSON.stringify({ url: "https://calm-otter.trycloudflare.com" }),
      },
      {
        path: "/secure-url",
        method: "PUT",
        body: JSON.stringify({ url: "http://192.168.1.5:9443" }),
      },
      { path: "/secure-url", method: "DELETE", body: undefined },
    ]);
    expect(output).toEqual([
      "Secure URL set to https://calm-otter.trycloudflare.com",
      "Secure URL set to http://192.168.1.5:9443",
      "Secure URL cleared.",
    ]);
  });

  test("reports failed cloudflared metrics reads without using a real network", async () => {
    const errors: string[] = [];
    const metricsCalls: string[] = [];
    const result = await runCli(["secure", "url", "--from-cloudflared"], {
      env,
      adminFetch: async () => success({}),
      fetch: async (input) => {
        metricsCalls.push(String(input));
        return new Response("", { status: 503 });
      },
      stderr: (text) => errors.push(text),
    });

    expect(result).toBe(1);
    expect(metricsCalls).toEqual([
      "http://127.0.0.1:20241/quicktunnel",
      "http://127.0.0.1:20242/quicktunnel",
      "http://127.0.0.1:20243/quicktunnel",
      "http://127.0.0.1:20244/quicktunnel",
      "http://127.0.0.1:20245/quicktunnel",
    ]);
    expect(errors[0]).toContain("could not read cloudflared Quick Tunnel metrics");
    expect(errors[0]).toContain("HTTP 503");
  });

  test("times out a stalled metrics body and tries the next address", async () => {
    const clock = new FakeClock();
    const output: string[] = [];
    const calls: string[] = [];
    let firstSignal: AbortSignal | null | undefined;
    let firstBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stalledBody = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          firstBodyController = controller;
        },
      }),
    );
    let bodyAborted = false;
    const resultPromise = runCli(["secure", "url", "--from-cloudflared"], {
      env,
      clock,
      adminFetch: async () => success({ url: "https://calm-otter.trycloudflare.com" }),
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push(url);
        if (calls.length === 1) {
          firstSignal = init.signal;
          firstSignal?.addEventListener(
            "abort",
            () => {
              bodyAborted = true;
              firstBodyController?.error(new Error("request aborted"));
            },
            { once: true },
          );
          return stalledBody;
        }
        return success({ hostname: "calm-otter.trycloudflare.com" });
      },
      stdout: (text) => output.push(text),
    });

    await flushMicrotasks();
    expect(calls).toEqual(["http://127.0.0.1:20241/quicktunnel"]);
    expect(stalledBody.body?.locked).toBe(true);
    expect(clock.pendingTimers).toBe(1);

    clock.advance(3_001);
    const result = await resultPromise;

    expect(result).toBe(0);
    expect(firstSignal?.aborted).toBe(true);
    expect(bodyAborted).toBe(true);
    expect(calls).toEqual([
      "http://127.0.0.1:20241/quicktunnel",
      "http://127.0.0.1:20242/quicktunnel",
    ]);
    expect(output).toEqual(["Secure URL set to https://calm-otter.trycloudflare.com"]);
    expect(clock.pendingTimers).toBe(0);
  });

  test("prints a safe error when the bridge starts with malformed identity JSON", async () => {
    const stateHome = await mkdtemp(join(process.cwd(), ".tmp-cli-identity-secret-"));
    try {
      const stateDir = join(stateHome, "herdr-bridge");
      await mkdir(stateDir, { recursive: true });
      const secret = "identity_secret_test_72";
      await writeFile(
        join(stateDir, "identity.json"),
        `{"v":1,"publicKey":"${PUBLIC_KEY}","secretKey":${secret}}`,
      );
      const output: string[] = [];
      const result = await runCli(
        ["serve", "--owner", "owner@example.test", "--public-url", "https://mac.example.test"],
        {
          env: { ...env, XDG_STATE_HOME: stateHome },
          stdout: (text) => output.push(text),
          stderr: (text) => output.push(text),
        },
      );

      expect(result).toBe(1);
      expect(output.join("\n")).toContain("identity file is not valid JSON");
      expect(output.join("\n")).not.toContain(secret);
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  test("identity prints only the public key", async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const result = await runCli(["identity"], {
      env,
      adminFetch: async (_socketPath, path) => {
        calls.push(path);
        return success({ bridgeKey: PUBLIC_KEY });
      },
      stdout: (text) => output.push(text),
    });

    expect(result).toBe(0);
    expect(calls).toEqual(["/status"]);
    expect(output).toEqual([PUBLIC_KEY]);
    expect(output.join("\n")).not.toContain(SECRET_KEY);
  });

  test("lists devices and revokes a named device over the admin request seam", async () => {
    const calls: { path: string; method: string }[] = [];
    const output: string[] = [];
    const adminFetch = async (_socketPath: string, path: string, init: RequestInit = {}) => {
      calls.push({ path, method: init.method ?? "GET" });
      return path === "/devices"
        ? success([{ id: "device-1", name: "Phone" }])
        : new Response(null, { status: 204 });
    };

    expect(
      await runCli(["devices"], { env, adminFetch, stdout: (text) => output.push(text) }),
    ).toBe(0);
    expect(output[0]).toContain("device-1");
    expect(
      await runCli(["devices", "revoke", "device-1"], {
        env,
        adminFetch,
        stdout: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(calls).toEqual([
      { path: "/devices", method: "GET" },
      { path: "/devices/device-1", method: "DELETE" },
    ]);
  });

  test("prints help and rejects bad pair options", async () => {
    const help: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => help.push(text) })).toBe(0);
    expect(help[0]).toContain("herdr-bridge serve");
    expect(help[0]).toContain("--run-program <name>");
    expect(help[0]).toContain("--run-root <dir>");
    expect(help[0]).toContain("secure url --from-cloudflared [host:port]");
    expect(help[0]).toContain("identity [rotate]");

    const errors: string[] = [];
    expect(await runCli(["pair", "--invalid"], { env, stderr: (text) => errors.push(text) })).toBe(
      1,
    );
    expect(errors[0]).toContain("unknown pair option");
  });
});

class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { callback: () => void; at: number }>();

  get pendingTimers(): number {
    return this.timers.size;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { callback, at: this.currentTime + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(ms: number): void {
    this.currentTime += ms;
    const due = Array.from(this.timers.entries()).filter(
      ([, timer]) => timer.at <= this.currentTime,
    );
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 5; iteration++) await Promise.resolve();
}

function base64UrlBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
