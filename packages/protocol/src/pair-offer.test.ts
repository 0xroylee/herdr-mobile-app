import { describe, expect, test } from "bun:test";
import {
  encodePairOffer,
  isPrivateOrLoopbackHost,
  normalizeOrigin,
  parsePairOffer,
} from "./pair-offer.ts";

describe("pair offers", () => {
  test("parses v1 links and round-trips a v2 link with UTF-8 fields", () => {
    const legacy = `#pair=${base64Url(JSON.stringify({ u: "https://mac.example.test", c: "ABCD2345" }))}`;
    expect(parsePairOffer(legacy)).toEqual({
      direct: "https://mac.example.test",
      code: "ABCD2345",
    });

    const offer = {
      direct: "https://mac.example.test/",
      secure: "http://192.168.1.5:9443",
      bridgeKey: base64UrlBytes(new Uint8Array(32).fill(7)),
      code: "ABCD2345",
      name: "Desk phone 香港",
    };
    const link = encodePairOffer(offer);
    expect(new URL(link).origin).toBe("http://192.168.1.5:9443");
    expect(parsePairOffer(link)).toEqual({ ...offer, direct: "https://mac.example.test" });
  });

  test("chooses the direct route as the link base when no secure route exists", () => {
    const link = encodePairOffer({ direct: "https://mac.example.test", code: "ABCD2345" });
    expect(new URL(link).origin).toBe("https://mac.example.test");
    expect(parsePairOffer(link)).toEqual({ direct: "https://mac.example.test", code: "ABCD2345" });
  });

  test("enforces each pair-offer field and origin validation rule", () => {
    expect(() => encodePairOffer({ code: "ABCD2345" })).toThrow(
      "requires a direct or secure route",
    );
    expect(() =>
      encodePairOffer({ direct: "https://mac.example.test/path", code: "ABCD2345" }),
    ).toThrow("without credentials, path");
    expect(() =>
      encodePairOffer({ direct: "https://user:pass@mac.example.test", code: "ABCD2345" }),
    ).toThrow("without credentials");
    expect(() =>
      encodePairOffer({ direct: "https://mac.example.test?x=1", code: "ABCD2345" }),
    ).toThrow("without credentials, path, query");
    expect(() =>
      encodePairOffer({ direct: "https://mac.example.test#fragment", code: "ABCD2345" }),
    ).toThrow("without credentials, path, query, or fragment");
    expect(() => encodePairOffer({ direct: "https://mac.example.test", code: "short" })).toThrow(
      "8 letters",
    );
    expect(() =>
      encodePairOffer({ direct: "https://mac.example.test", bridgeKey: "short", code: "ABCD2345" }),
    ).toThrow("32 bytes");
    expect(() =>
      normalizeOrigin("http://example.test", { allowPlainHttp: "loopback-only" }),
    ).toThrow("loopback host");
    expect(() =>
      normalizeOrigin("http://example.test", { allowPlainHttp: "loopback-and-private" }),
    ).toThrow("loopback or private-network host");
    expect(normalizeOrigin("http://127.0.0.1:8790/", { allowPlainHttp: "loopback-only" })).toBe(
      "http://127.0.0.1:8790",
    );
    expect(() =>
      normalizeOrigin("http://[::ffff:127.0.0.1]", { allowPlainHttp: "loopback-only" }),
    ).not.toThrow();
  });

  test("recognizes loopback, private IPv4, private IPv6 and link-local hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.5",
      "169.254.1.2",
      "::1",
      "fc00::1",
      "fdff::2",
      "fe80::1",
      "::ffff:192.168.1.2",
    ]) {
      expect(isPrivateOrLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.test", "172.32.0.1", "192.167.1.2", "2001:db8::1", "::"]) {
      expect(isPrivateOrLoopbackHost(host)).toBe(false);
    }
    expect(
      normalizeOrigin("http://192.168.1.5:9443", { allowPlainHttp: "loopback-and-private" }),
    ).toBe("http://192.168.1.5:9443");
    expect(normalizeOrigin("http://example.test", { allowPlainHttp: "any" })).toBe(
      "http://example.test",
    );
  });

  test("returns undefined for malformed, unknown-version and invalid-key fragments", () => {
    expect(parsePairOffer("#other=value")).toBeUndefined();
    expect(parsePairOffer("#pair=not-base64!")).toBeUndefined();
    expect(
      parsePairOffer(
        `https://example.test/#pair=${base64Url(JSON.stringify({ v: 9, c: "ABCD2345" }))}`,
      ),
    ).toBe(undefined);
    expect(
      parsePairOffer(
        `#pair=${base64Url(JSON.stringify({ v: 2, u: "https://example.test", k: "short", c: "ABCD2345" }))}`,
      ),
    ).toBeUndefined();
    expect(
      parsePairOffer(
        `#pair=${base64Url(JSON.stringify({ v: 2, u: "http://example.test", c: "ABCD2345" }))}`,
      ),
    ).toEqual({ direct: "http://example.test", code: "ABCD2345" });
  });
});

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlBytes(bytes: Uint8Array): string {
  return base64Url(String.fromCharCode(...bytes));
}
