import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { OwnedProcess, ProcessRunner } from "../prototype/process.ts";
import { checkIdentity, createWhoisLookup } from "./identity.ts";

class FakeClock implements Clock {
  time = 1_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

class FakeChild implements OwnedProcess {
  readonly exited: Promise<number | null>;
  killed = false;
  private resolveExit: (code: number | null) => void = () => {};
  private readonly output: string;
  private readonly hold: boolean;

  constructor(output: string, exitCode: number | null, hold: boolean) {
    this.output = output;
    this.hold = hold;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
      if (!hold) resolve(exitCode);
    });
  }

  write(): void {}
  closeInput(): void {}

  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void {
    if (this.hold) return;
    onData(new TextEncoder().encode(this.output));
    onEnd();
  }

  kill(): void {
    this.killed = true;
    this.resolveExit(null);
  }
}

class FakeRunner implements ProcessRunner {
  readonly calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  private readonly child: FakeChild;

  constructor(child: FakeChild) {
    this.child = child;
  }

  spawn(argv: string[], options: { env: Record<string, string>; cwd: string }): OwnedProcess {
    this.calls.push({ argv, ...options });
    return this.child;
  }
}

const OWNER = "owner@example.ts.net";
const ENV = { PATH: "/usr/bin:/bin" };
const CWD = "/bridge";

function headers(login = OWNER, address = "100.64.0.12"): Headers {
  const value = new Headers();
  if (login) value.set("Tailscale-User-Login", login);
  if (address) value.set("X-Forwarded-For", address);
  return value;
}

describe("checkIdentity", () => {
  test("accepts the configured login in header-only mode", async () => {
    expect(await checkIdentity(headers(), { ownerLogin: OWNER })).toBe(true);
  });

  test("rejects a missing or different login before calling whois", async () => {
    let calls = 0;
    const whois = async () => {
      calls++;
      return OWNER;
    };

    expect(await checkIdentity(headers(""), { ownerLogin: OWNER }, whois)).toBe(false);
    expect(await checkIdentity(headers("other@example.ts.net"), { ownerLogin: OWNER }, whois)).toBe(
      false,
    );
    expect(calls).toBe(0);
  });

  test("whois receives the forwarded address and must confirm the owner", async () => {
    const requested: string[] = [];
    const whois = async (address: string) => {
      requested.push(address);
      return OWNER;
    };
    expect(await checkIdentity(headers(), { ownerLogin: OWNER }, whois)).toBe(true);
    expect(requested).toEqual(["100.64.0.12"]);
    expect(
      await checkIdentity(headers(OWNER, "100.64.0.12, 100.64.0.1"), { ownerLogin: OWNER }, whois),
    ).toBe(false);
    expect(await checkIdentity(headers(OWNER, ""), { ownerLogin: OWNER }, whois)).toBe(false);

    const mismatch = async () => "another@example.ts.net";
    expect(await checkIdentity(headers(), { ownerLogin: OWNER }, mismatch)).toBe(false);
    expect(
      await checkIdentity(headers(), { ownerLogin: OWNER }, async () => {
        throw new Error("whois failed");
      }),
    ).toBe(false);
  });
});

describe("createWhoisLookup", () => {
  test("runs tailscale whois with the forwarded address and parses UserProfile.LoginName", async () => {
    const child = new FakeChild('{"UserProfile":{"LoginName":"owner@example.ts.net"}}', 0, false);
    const runner = new FakeRunner(child);
    const lookup = createWhoisLookup(runner, { env: ENV, cwd: CWD });

    await expect(lookup("100.64.0.12")).resolves.toBe(OWNER);
    expect(runner.calls).toEqual([
      {
        argv: ["tailscale", "whois", "--json", "100.64.0.12"],
        env: ENV,
        cwd: CWD,
      },
    ]);
  });

  test("refuses a non-zero exit and unreadable JSON", async () => {
    const failed = createWhoisLookup(new FakeRunner(new FakeChild("", 1, false)), {
      env: ENV,
      cwd: CWD,
    });
    await expect(failed("100.64.0.12")).rejects.toThrow("exited unsuccessfully");

    const unreadable = createWhoisLookup(new FakeRunner(new FakeChild("not-json", 0, false)), {
      env: ENV,
      cwd: CWD,
    });
    await expect(unreadable("100.64.0.12")).rejects.toThrow();
  });

  test("kills its owned child when whois exceeds the five-second deadline", async () => {
    const clock = new FakeClock();
    const child = new FakeChild("", null, true);
    const lookup = createWhoisLookup(new FakeRunner(child), {
      env: ENV,
      cwd: CWD,
      clock,
    });
    const result = lookup("100.64.0.12");
    await Promise.resolve();
    clock.advance(5_000);

    await expect(result).rejects.toThrow("tailscale whois");
    expect(child.killed).toBe(true);
  });
});
