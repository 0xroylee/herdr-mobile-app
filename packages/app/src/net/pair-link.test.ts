/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { parsePairFragment, parseTypedPairInput } from "./pair-link.ts";

describe("pair link", () => {
  test("parses the base64url pair fragment without sending it as part of the URL", () => {
    const payload = base64Url(JSON.stringify({ u: "https://mac.tailnet.ts.net", c: "ABCD2345" }));

    expect(parsePairFragment(`https://mac.tailnet.ts.net/#pair=${payload}`)).toEqual({
      direct: "https://mac.tailnet.ts.net",
      code: "ABCD2345",
    });
  });

  test("normalizes typed input and rejects malformed URLs or codes", () => {
    expect(parseTypedPairInput("https://mac.tailnet.ts.net/", "  ABCD2345 ")).toEqual({
      direct: "https://mac.tailnet.ts.net",
      code: "ABCD2345",
    });
    expect(parseTypedPairInput("javascript:alert(1)", "ABCD2345")).toBeUndefined();
    expect(parseTypedPairInput("https://mac.tailnet.ts.net/path", "ABCD2345")).toBeUndefined();
    expect(parseTypedPairInput("https://mac.tailnet.ts.net", "short")).toBeUndefined();
  });

  test("preserves every route and the pinned key from a v2 pair offer", () => {
    const payload = base64Url(
      JSON.stringify({
        v: 2,
        u: "https://mac.tailnet.ts.net",
        s: "https://bridge.example.test",
        k: base64Url("x".repeat(32)),
        c: "ABCD2345",
      }),
    );

    expect(parsePairFragment(`#pair=${payload}`)).toEqual({
      direct: "https://mac.tailnet.ts.net",
      secure: "https://bridge.example.test",
      bridgeKey: base64Url("x".repeat(32)),
      code: "ABCD2345",
    });
  });

  test("returns undefined for malformed or unrelated fragments without throwing", () => {
    expect(parsePairFragment("https://mac.tailnet.ts.net/#other=value")).toBeUndefined();
    expect(parsePairFragment("#pair=not-base64!")).toBeUndefined();
    expect(parsePairFragment("#pair=eyJ1IjoieCIsImMiOiJzaG9ydCJ9")).toBeUndefined();
  });
});

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
