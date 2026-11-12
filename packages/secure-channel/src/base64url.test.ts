import { describe, expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";

describe("base64url", () => {
  test("round-trips byte lengths with each padding shape", () => {
    for (let length = 0; length < 20; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 43 + 211) & 0xff);
      expect(Array.from(decodeBase64Url(encodeBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test("uses the URL-safe alphabet and omits padding", () => {
    expect(encodeBase64Url(new Uint8Array([255, 238]))).toBe("_-4");
    expect(encodeBase64Url(new Uint8Array([255, 255]))).toBe("__8");
  });

  test("rejects invalid and non-canonical input", () => {
    for (const text of ["A", "AA=", "AA+", "AB", "AAB"]) {
      expect(() => decodeBase64Url(text)).toThrow(TypeError);
    }
  });
});
