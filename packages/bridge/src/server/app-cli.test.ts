import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import type { AppCliContext } from "./app-cli.ts";
import { handleAppCli } from "./app-cli.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";

class MapFs implements StoreFs {
  readonly files = new Map<string, string>();
  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async mkdir(): Promise<void> {}
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("missing temporary file");
    this.files.delete(from);
    this.files.set(to, value);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeClock implements Clock {
  private nextId = 1;

  now(): number {
    return 1_000;
  }
  setTimeout(): unknown {
    return this.nextId++;
  }
  clearTimeout(): void {}
}

class ManualClock implements Clock {
  callback: (() => void) | undefined;
  delayMs: number | undefined;

  now(): number {
    return 1_000;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    this.callback = callback;
    this.delayMs = ms;
    return 1;
  }
  clearTimeout(): void {
    this.callback = undefined;
  }
  fire(): void {
    this.callback?.();
  }
}

class FakeChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  killed = false;
  readonly stdoutText: string;
  readonly stderrText: string;

  constructor(stdoutText: string, stderrText: string, exitCode: number | null) {
    this.stdoutText = stdoutText;
    this.stderrText = stderrText;
    this.exited = Promise.resolve(exitCode);
  }

  write(): void {}
  closeInput(): void {}
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stdoutText) onData(new TextEncoder().encode(this.stdoutText));
    onEnd();
  }
  readStderr(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.stderrText) onData(new TextEncoder().encode(this.stderrText));
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class FakeRunner implements ProcessRunner {
  argv: string[][] = [];
  child: OwnedProcess = new FakeChild('{"spaces":[]}', "", 0);

  spawn(
    argv: string[],
    _options: { env: Record<string, string>; cwd: string; stderr?: "pipe" },
  ): OwnedProcess {
    this.argv.push(argv);
    return this.child;
  }
}

class HangingChild implements OwnedProcess {
  readonly exited = new Promise<number | null>(() => {});
  killed = false;
  write(): void {}
  closeInput(): void {}
  read(): void {}
  readStderr(): void {}
  kill(): void {
    this.killed = true;
  }
}

async function context(clock: Clock = new FakeClock()) {
  const devices = await DeviceStore.open(new MapFs(), "/state/devices.json", new FakeClock());
  await devices.add({ token: "control-token", role: "control", name: "Control phone" });
  await devices.add({ token: "watch-token", role: "watch", name: "Watch phone" });
  const runner = new FakeRunner();
  const options: AppCliContext = {
    identity: { ownerLogin: "owner@example.com" },
    devices,
    runner,
    env: { PATH: "/usr/bin" },
    cwd: "/Users/owner",
    herdrAppPath: "/opt/herdr/bin/herdr-app",
    clock,
  };
  return { options, runner };
}

function request(path: string, token: string, method = "GET", body?: string): Request {
  return new Request(`http://bridge${path}`, {
    method,
    headers: {
      "Tailscale-User-Login": "owner@example.com",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
  });
}

describe("herdr-app CLI API", () => {
  test("returns ls JSON as-is using the configured executable", async () => {
    const { options, runner } = await context();
    runner.child = new FakeChild('{"spaces":[{"name":"Work"}]}\n', "", 0);

    const response = await handleAppCli(request("/api/app/ls", "control-token"), options);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('{"spaces":[{"name":"Work"}]}\n');
    expect(runner.argv).toEqual([["/opt/herdr/bin/herdr-app", "ls"]]);
  });

  test("allows only space.new and tab.new and builds argv without a shell", async () => {
    const { options, runner } = await context();
    const response = await handleAppCli(
      request(
        "/api/app/do",
        "control-token",
        "POST",
        JSON.stringify({ action: "space.new", args: { name: "Planning", task: "Review code" } }),
      ),
      options,
    );
    expect(response?.status).toBe(200);
    expect(runner.argv).toEqual([
      [
        "/opt/herdr/bin/herdr-app",
        "do",
        "space.new",
        "--name",
        "Planning",
        "--task",
        "Review code",
      ],
    ]);
  });

  test("requires matching identity and a control device", async () => {
    const { options, runner } = await context();
    const wrongIdentity = new Request("http://bridge/api/app/ls", {
      headers: { Authorization: "Bearer control-token", "Tailscale-User-Login": "other" },
    });
    expect((await handleAppCli(wrongIdentity, options))?.status).toBe(403);
    expect((await handleAppCli(request("/api/app/ls", "watch-token"), options))?.status).toBe(403);
    expect((await handleAppCli(request("/api/app/ls", "missing"), options))?.status).toBe(401);
    expect(runner.argv).toEqual([]);
  });

  test("rejects unknown actions, invalid flag names and non-string values", async () => {
    const { options, runner } = await context();
    for (const body of [
      { action: "doc.set", args: {} },
      { action: "tab.new", args: { bad_name: "value" } },
      { action: "space.new", args: { name: 1 } },
    ]) {
      const response = await handleAppCli(
        request("/api/app/do", "control-token", "POST", JSON.stringify(body)),
        options,
      );
      expect(response?.status).toBe(400);
    }
    expect(runner.argv).toEqual([]);
  });

  test("reports non-zero exit as 409 with stderr", async () => {
    const { options, runner } = await context();
    runner.child = new FakeChild("", "Herdr isn't running on this Mac", 1);
    const response = await handleAppCli(
      request("/api/app/do", "control-token", "POST", JSON.stringify({ action: "tab.new" })),
      options,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "herdr_app_failed",
      message: "Herdr isn't running on this Mac",
    });
  });

  test("kills a herdr-app process at the ten-second deadline", async () => {
    const clock = new ManualClock();
    const { options, runner } = await context(clock);
    const child = new HangingChild();
    runner.child = child;
    const responsePromise = handleAppCli(
      request("/api/app/do", "control-token", "POST", JSON.stringify({ action: "space.new" })),
      options,
    );
    for (let index = 0; index < 20 && clock.callback === undefined; index++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(clock.delayMs).toBe(10_000);
    clock.fire();
    const response = await responsePromise;
    expect(response?.status).toBe(504);
    expect(child.killed).toBe(true);
  });
});
