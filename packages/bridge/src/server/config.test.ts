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
      programs: ["claude", "codex"],
      roots: ["/Users/bridge"],
      home: "/Users/bridge",
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
        "--run-program",
        "aider",
        "--run-program",
        "opencode",
        "--run-root",
        "../shared",
        "--run-root",
        "~",
        "--run-root",
        "/Users/bridge",
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
      programs: ["claude", "codex", "aider", "opencode"],
      roots: ["/Users/bridge", "/shared"],
      home: "/Users/bridge",
    });
    expect(runner.calls).toEqual([]);
  });

  test("lists home first and de-duplicates run roots lexically without filesystem resolution", async () => {
    const config = await createBridgeConfig(
      [
        "--owner",
        "owner@example.com",
        "--public-url",
        "https://mac.tailnet.example",
        "--run-root",
        "../shared",
        "--run-root",
        "~",
        "--run-root",
        "/offline",
        "--run-root",
        "/offline",
      ],
      {
        runner: new FakeRunner(),
        env,
        cwd: "/repo",
      },
    );

    expect(config.roots).toEqual(["/Users/bridge", "/shared", "/offline"]);
  });

  test("does not resolve roots while creating configuration", async () => {
    const runner = new FakeRunner();
    const config = await createBridgeConfig(
      ["--owner", "owner@example.com", "--run-root", "/stalled"],
      { runner, env, cwd: "/repo" },
    );

    expect(config.roots).toEqual(["/Users/bridge", "/stalled"]);
    expect(runner.calls.map(({ argv }) => argv)).toEqual([["tailscale", "status", "--json"]]);
  });

  test("rejects invalid owner, flags, port and public URL", () => {
    expect(() => parseServeFlags([], "/repo")).toThrow("--owner");
    expect(() => parseServeFlags(["--owner", "owner", "--port", "0"], "/repo")).toThrow("--port");
    expect(() => parseServeFlags(["--owner", "owner", "--unknown"], "/repo")).toThrow(
      "unknown serve option",
    );
    expect(() =>
      parseServeFlags(["--owner", "owner", "--run-program", "../claude"], "/repo"),
    ).toThrow("--run-program");
    expect(() =>
      parseServeFlags(["--owner", "owner", "--public-url", "http://example.com"], "/repo"),
    ).toThrow("loopback");
  });

  test("accepts loopback-only HTTP direct origins and private-network HTTP secure origins", async () => {
    const config = await createBridgeConfig(
      [
        "--owner",
        "owner@example.com",
        "--port",
        "8790",
        "--public-url",
        "http://127.0.0.1:8790",
        "--secure-port",
        "9443",
        "--secure-url",
        "http://192.168.1.5:9443/",
      ],
      { runner: new FakeRunner(), env, cwd: "/repo" },
    );

    expect(config.publicUrl).toBe("http://127.0.0.1:8790");
    expect(config.secure).toEqual({ port: 9443, url: "http://192.168.1.5:9443" });
  });

  test("requires a distinct secure port and pairs --secure-url with --secure-port", () => {
    expect(() =>
      parseServeFlags(["--owner", "owner", "--port", "9443", "--secure-port", "9443"], "/repo"),
    ).toThrow("different from --port");
    expect(() =>
      parseServeFlags(["--owner", "owner", "--secure-url", "https://bridge.example.test"], "/repo"),
    ).toThrow("requires --secure-port");
    expect(() =>
      parseServeFlags(
        ["--owner", "owner", "--secure-port", "9443", "--secure-url", "http://example.test"],
        "/repo",
      ),
    ).toThrow("loopback or private-network");
  });

  test("rejects private-network and public HTTP direct origins", () => {
    expect(() =>
      parseServeFlags(["--owner", "owner", "--public-url", "http://192.168.1.5:8790"], "/repo"),
    ).toThrow("loopback");
    expect(() =>
      parseServeFlags(["--owner", "owner", "--public-url", "http://example.test"], "/repo"),
    ).toThrow("loopback");
  });

  test("refuses to bind any host other than 127.0.0.1", () => {
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow("must be 127.0.0.1");
    expect(() => assertLoopbackHost("::")).toThrow("must be 127.0.0.1");
  });
});
