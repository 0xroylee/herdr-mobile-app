import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { StoreFs } from "./devices.ts";
import { encodePublicKey, openIdentityKey } from "./identity-key.ts";

const IDENTITY_FILE = "/state/identity.json";

class MapStoreFs implements StoreFs {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; contents: string; mode: number; flag: "wx" }[] = [];

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async mkdir(): Promise<void> {}
  async writeFile(
    path: string,
    contents: string,
    options: { mode: number; flag: "wx" },
  ): Promise<void> {
    this.writes.push({ path, contents, ...options });
    this.files.set(path, contents);
  }
  async rename(from: string, to: string): Promise<void> {
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error("missing temporary file");
    this.files.delete(from);
    this.files.set(to, contents);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeClock implements Clock {
  now(): number {
    return 1_000;
  }
  setTimeout(): unknown {
    throw new Error("identity keys do not schedule timers");
  }
  clearTimeout(): void {}
}

describe("openIdentityKey", () => {
  test("creates once, persists base64url keys with mode 0600, and reloads the same identity", async () => {
    const fs = new MapStoreFs();
    const first = await openIdentityKey(IDENTITY_FILE, fs, new FakeClock());
    const keyPair = first.current();
    const stored = JSON.parse(fs.files.get(IDENTITY_FILE) ?? "null") as Record<string, unknown>;

    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]).toMatchObject({ mode: 0o600, flag: "wx" });
    expect(stored).toMatchObject({
      v: 1,
      publicKey: encodePublicKey(keyPair.publicKey),
      secretKey: encodePublicKey(keyPair.secretKey),
    });
    expect(encodePublicKey(keyPair.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const second = await openIdentityKey(IDENTITY_FILE, fs, new FakeClock());
    expect(second.current()).toEqual(keyPair);
    expect(fs.writes).toHaveLength(1);
  });

  test("rotates to a different key and notifies listeners only after persistence", async () => {
    const fs = new MapStoreFs();
    const store = await openIdentityKey(IDENTITY_FILE, fs, new FakeClock());
    const previous = store.current();
    const seen: string[] = [];
    store.onRotate((keyPair) => {
      seen.push(encodePublicKey(keyPair.publicKey));
      expect(JSON.parse(fs.files.get(IDENTITY_FILE) ?? "null").publicKey).toBe(
        encodePublicKey(keyPair.publicKey),
      );
    });

    const next = await store.rotate();
    expect(encodePublicKey(next.publicKey)).not.toBe(encodePublicKey(previous.publicKey));
    expect(next.secretKey).not.toEqual(previous.secretKey);
    expect(seen).toEqual([encodePublicKey(next.publicKey)]);
    expect(store.current()).toEqual(next);
  });

  test("rejects corrupt files and paths other than identity.json", async () => {
    const fs = new MapStoreFs();
    fs.files.set(IDENTITY_FILE, "not-json");
    await expect(openIdentityKey(IDENTITY_FILE, fs, new FakeClock())).rejects.toThrow(
      "invalid identity key file",
    );
    await expect(openIdentityKey("/state/devices.json", fs, new FakeClock())).rejects.toThrow(
      "identity.json",
    );
  });

  test("does not include malformed identity contents in the error", async () => {
    const fs = new MapStoreFs();
    const secret = "identity_secret_test_72";
    fs.files.set(
      IDENTITY_FILE,
      `{"v":1,"publicKey":"${encodePublicKey(new Uint8Array(32).fill(7))}","secretKey":${secret}}`,
    );

    const error = await openIdentityKey(IDENTITY_FILE, fs, new FakeClock()).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("identity file is not valid JSON");
    expect(message).not.toContain(secret);
  });
});
