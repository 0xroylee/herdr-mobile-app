import { describe, expect, test } from "bun:test";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { assertLoopbackHost, createBridgeConfig, parseServeFlags } from "./config.ts";

class FakeChild implements OwnedProcess {
  readonly exited = Promise.resolve(0);
  killed = false;
  private readonly output: string;

  constructor(output: string) {
    this.output = output;
  }

  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onData(new TextEncoder().encode(this.output));
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class FakeRunner implements ProcessRunner {
  calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  output = JSON.stringify({ Self: { DNSName: "mac.tailnet.example." } });

  spawn(argv: string[], options: { env: Record<string, string>; cwd: string }): OwnedProcess {
    this.calls.push({ argv, ...options });
    return new FakeChild(this.output);
  }
}

const env = {
  HOME: "/Users/bridge",
  PATH: "/usr/bin:/bin",
  HC_SESSION: "should-not-be-forwarded-to-tailscale",
};

describe("bridge config", () => {
  test("uses defaults and resolves the Tailscale DNS name without its trailing dot", async () => {
    const runner = new FakeRunner();
    const config = await createBridgeConfig(["--owner", "owner@example.com"], {
      runner,
      env,
      cwd: "/repo",
      machine: { id: "machine-id", name: "My Mac" },
    });

    expect(config).toMatchObject({
      ownerLogin: "owner@example.com",
      host: "127.0.0.1",
      port: 8787,
      publicUrl: "https://mac.tailnet.example",
      webDir: "/repo/packages/app/dist",
      hcPath: "hc",
      herdrAppPath: "herdr-app",
      stateDir: "/Users/bridge/.local/state/herdr-bridge",
      deviceFilePath: "/Users/bridge/.local/state/herdr-bridge/devices.json",
      adminSocketPath: "/Users/bridge/.local/state/herdr-bridge/admin.sock",
      machine: { id: "machine-id", name: "My Mac" },
    });
    expect(runner.calls).toEqual([
      {
        argv: ["tailscale", "status", "--json"],
        env: {
          HOME: "/Users/bridge",
          PATH: "/usr/bin:/bin",
          HC_SESSION: "should-not-be-forwarded-to-tailscale",
        },
        cwd: "/repo",
      },
    ]);
  });

  test("accepts configured paths, session, whois, port and public URL", async () => {
    const runner = new FakeRunner();
    const config = await createBridgeConfig(
      [
        "--owner",
        "owner@example.com",
        "--port",
        "9888",
        "--public-url",
        "https://custom.tailnet.example/",
        "--web",
        "./web",
        "--hc",
        "/opt/herdr/bin/hc",
        "--herdr-app",
        "/opt/herdr-app/bin/herdr-app",
        "--session",
        "work",
        "--whois",
      ],
      { runner, env, cwd: "/repo" },
    );
    expect(config).toMatchObject({
      port: 9888,
      publicUrl: "https://custom.tailnet.example",
      webDir: "/repo/web",
      hcPath: "/opt/herdr/bin/hc",
      herdrAppPath: "/opt/herdr-app/bin/herdr-app",
      session: "work",
      whois: true,
    });
    expect(runner.calls).toEqual([]);
  });

  test("rejects invalid owner, flags, port and public URL", () => {
    expect(() => parseServeFlags([], "/repo")).toThrow("--owner");
    expect(() => parseServeFlags(["--owner", "owner", "--port", "0"], "/repo")).toThrow("--port");
    expect(() => parseServeFlags(["--owner", "owner", "--unknown"], "/repo")).toThrow(
      "unknown serve option",
    );
    expect(() =>
      parseServeFlags(["--owner", "owner", "--public-url", "http://example.com"], "/repo"),
    ).toThrow("HTTPS");
  });

  test("refuses to bind any host other than 127.0.0.1", () => {
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow("must be 127.0.0.1");
    expect(() => assertLoopbackHost("::")).toThrow("must be 127.0.0.1");
  });
});
