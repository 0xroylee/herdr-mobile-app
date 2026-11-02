import { describe, expect, test } from "bun:test";
import { createToken, hashToken } from "./tokens.ts";

describe("bridge tokens", () => {
  test("creates an unpadded base64url token from 32 random bytes", () => {
    const token = createToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toContain("=");
  });

  test("hashes tokens with Web Crypto SHA-256", async () => {
    await expect(hashToken("abc")).resolves.toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    await expect(hashToken("abc")).resolves.toBe(await hashToken("abc"));
    await expect(hashToken("abc")).resolves.not.toBe(await hashToken("abd"));
  });
});
