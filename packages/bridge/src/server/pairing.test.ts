import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import { PairingCodes } from "./pairing.ts";

class FakeClock implements Clock {
  time = 1_000_000;

  now(): number {
    return this.time;
  }

  setTimeout(): unknown {
    throw new Error("pairing does not schedule timers");
  }

  clearTimeout(): void {}
}

describe("PairingCodes", () => {
  test("issues an unambiguous eight-character code that redeems once", () => {
    const clock = new FakeClock();
    const pairing = new PairingCodes(clock);
    const issued = pairing.issue("control", "Desk phone");

    expect(issued.expiresAt).toBe(clock.now() + 600_000);
    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/u);
    expect(pairing.redeem(issued.code)).toEqual({ role: "control", name: "Desk phone" });
    expect(pairing.redeem(issued.code)).toBeUndefined();
  });

  test("issues codes that use only the unambiguous alphabet", () => {
    const pairing = new PairingCodes(new FakeClock());
    const issued = Array.from({ length: 500 }, () => pairing.issue("watch").code);

    expect(issued).toHaveLength(500);
    for (const code of issued) {
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/u);
    }
  });

  test("expires at ten minutes on the injected clock", () => {
    const clock = new FakeClock();
    const pairing = new PairingCodes(clock);
    const issued = pairing.issue("watch");
    clock.time = issued.expiresAt - 1;
    expect(pairing.redeem(issued.code)).toEqual({ role: "watch" });

    const expiring = pairing.issue("watch");
    clock.time += 600_000;
    expect(pairing.redeem(expiring.code)).toBeUndefined();
  });

  test("allows four wrong attempts and burns the code on the fifth", () => {
    const pairing = new PairingCodes(new FakeClock());
    const issued = pairing.issue("watch");
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(pairing.redeem("WRONGCODE")).toBeUndefined();
    }
    expect(pairing.redeem(issued.code)).toEqual({ role: "watch" });

    const exhausted = pairing.issue("control");
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(pairing.redeem("WRONGCODE")).toBeUndefined();
    }
    expect(pairing.redeem(exhausted.code)).toBeUndefined();
  });

  test("issuing a replacement invalidates the previous code", () => {
    const pairing = new PairingCodes(new FakeClock());
    const previous = pairing.issue("watch");
    const replacement = pairing.issue("control", "Tablet");

    expect(pairing.redeem(previous.code)).toBeUndefined();
    expect(pairing.redeem(replacement.code)).toEqual({ role: "control", name: "Tablet" });
  });
});
