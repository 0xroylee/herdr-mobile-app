import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { callCore } from "./core-call.ts";

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

class ScriptedChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  request: Record<string, unknown> | undefined;
  inputClosed = false;
  killed = false;
  private output: ((bytes: Uint8Array) => void) | undefined;
  private outputEnd: (() => void) | undefined;
  private resolveExit: (code: number | null) => void = () => {};
  private readonly response: (request: Record<string, unknown>) => unknown;
  private readonly exitCode: number | null;

  constructor(
    response: (request: Record<string, unknown>) => unknown,
    exitCode: number | null = 0,
  ) {
    this.response = response;
    this.exitCode = exitCode;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): void {
    this.request = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  }
  closeInput(): void {
    this.inputClosed = true;
    const request = this.request;
    if (!request) throw new Error("request was not written before stdin closed");
    const result = this.response(request);
    const reply = {
      jsonrpc: "2.0",
      id: request.id,
      ...(isErrorResult(result) ? { error: result.error } : { result }),
    };
    this.output?.(new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
    this.outputEnd?.();
    this.resolveExit(this.exitCode);
  }
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    this.output = onData;
    this.outputEnd = onEnd;
  }
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {
    this.killed = true;
    this.outputEnd?.();
    this.resolveExit(null);
  }
}

function isErrorResult(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}

class HangingChild implements OwnedProcess {
  readonly exited = new Promise<number | null>(() => {});
  inputClosed = false;
  killed = false;
  write(): void {}
  closeInput(): void {
    this.inputClosed = true;
  }
  read(): void {}
  readStderr(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {
    this.killed = true;
  }
}

class EmptyExitChild implements OwnedProcess {
  readonly exited = Promise.resolve(0);
  write(): void {}
  closeInput(): void {}
  read(_onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    onEnd();
  }
  kill(): void {}
}

class FakeRunner implements ProcessRunner {
  readonly argv: string[][] = [];
  readonly options: { env: Record<string, string>; cwd: string }[] = [];
  child: OwnedProcess;

  constructor(child: OwnedProcess) {
    this.child = child;
  }
  spawn(
    argv: string[],
    options: { env: Record<string, string>; cwd: string; stderr?: "pipe" },
  ): OwnedProcess {
    this.argv.push(argv);
    this.options.push({ env: options.env, cwd: options.cwd });
    return this.child;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("callCore", () => {
  test("sends one plain JSON-RPC request and closes the short-lived connection", async () => {
    const child = new ScriptedChild(() => ({ templates: [] }));
    const runner = new FakeRunner(child);
    const result = await callCore(
      {
        runner,
        hcPath: "/opt/herdr/bin/hc",
        session: "work",
        env: {
          PATH: "/usr/bin",
          HOME: "/Users/owner",
          HC_SOCKET: "/must/not/pass.sock",
          HC_SESSION: "parent-session",
        },
        cwd: "/repo",
      },
      "templates.list",
      {},
    );

    expect(result).toEqual({ templates: [] });
    expect(runner.argv).toEqual([["/opt/herdr/bin/hc", "connect"]]);
    expect(runner.options).toEqual([
      {
        cwd: "/repo",
        env: { PATH: "/usr/bin", HOME: "/Users/owner", HC_SESSION: "work" },
      },
    ]);
    expect(child.inputClosed).toBe(true);
    expect(child.killed).toBe(false);
    expect(child.request).toMatchObject({
      jsonrpc: "2.0",
      method: "templates.list",
      params: {},
    });
  });

  test("preserves a core JSON-RPC error", async () => {
    const child = new ScriptedChild(() => ({
      error: { code: -32000, message: "invalid template", data: { kind: "invalid_template" } },
    }));
    const runner = new FakeRunner(child);
    const error = await callCore({ runner, hcPath: "hc", env: {}, cwd: "/" }, "terminal.run", {
      argv: ["bad"],
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HcRpcError);
    expect((error as HcRpcError).kind).toBe("invalid_template");
    expect(child.killed).toBe(true);
  });

  test("reports an unsuccessful hc connect exit as spawn_failed", async () => {
    const child = new ScriptedChild(() => ({ templates: [] }), 7);
    const error = await callCore(
      { runner: new FakeRunner(child), hcPath: "hc", env: {}, cwd: "/" },
      "templates.list",
      {},
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: "HcConnectError", kind: "spawn_failed" });
    expect(child.killed).toBe(true);
  });

  test("reports a failed hc connect spawn as spawn_failed", async () => {
    const runner: ProcessRunner = {
      spawn() {
        throw new Error("executable not found");
      },
    };
    const error = await callCore(
      { runner, hcPath: "hc", env: {}, cwd: "/" },
      "templates.list",
      {},
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: "HcConnectError", kind: "spawn_failed" });
    expect((error as Error).message).toContain("executable not found");
  });

  test("reports a closed connection without a reply as spawn_failed", async () => {
    const error = await callCore(
      { runner: new FakeRunner(new EmptyExitChild()), hcPath: "hc", env: {}, cwd: "/" },
      "templates.list",
      {},
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: "HcConnectError", kind: "spawn_failed" });
  });

  test("kills a connection that misses the ten-second deadline", async () => {
    const clock = new ManualClock();
    const child = new HangingChild();
    const promise = callCore(
      { runner: new FakeRunner(child), hcPath: "hc", env: {}, cwd: "/", clock },
      "templates.list",
      {},
    );
    for (let index = 0; index < 8 && clock.callback === undefined; index++) await settle();
    expect(clock.delayMs).toBe(10_000);
    clock.fire();
    await expect(promise).rejects.toThrow("deadline exceeded: hc connect");
    expect(child.inputClosed).toBe(true);
    expect(child.killed).toBe(true);
  });
});
