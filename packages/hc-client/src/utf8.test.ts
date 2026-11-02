import { describe, expect, test } from "bun:test";
import { utf8Decode, utf8Encode } from "./utf8.ts";

// The runtime code avoids TextEncoder and TextDecoder for Hermes; Bun's are the reference here.
const reference = { encoder: new TextEncoder(), decoder: new TextDecoder() };

describe("utf8Encode", () => {
  test("matches TextEncoder, lone surrogates included", () => {
    const samples = [
      "",
      "hello",
      "é 漢 🙂",
      "\u007f\u0080߿ࠀ￿",
      "😀 pair",
      "\ud800 lone high",
      "lone low \udc00",
      "\udc00\ud800 reversed",
      "end high \ud83d",
    ];
    for (const text of samples) {
      expect(utf8Encode(text)).toEqual(reference.encoder.encode(text));
    }
  });
});

describe("utf8Decode", () => {
  test("matches TextDecoder on valid and invalid sequences", () => {
    const samples = [
      [0x68, 0x69],
      [0xff],
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0xe2, 0x82, 0x41],
      [0xf0, 0x9f, 0x99],
      [0xf0, 0x9f, 0x99, 0x82, 0x80],
      [0x61, 0xf5, 0x62],
    ];
    for (const sample of samples) {
      const input = Uint8Array.from(sample);
      expect(utf8Decode(input)).toBe(reference.decoder.decode(input));
    }
  });

  test("matches TextDecoder on random bytes", () => {
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let round = 0; round < 2000; round++) {
      const input = Uint8Array.from({ length: next() % 24 }, () => {
        const pick = next() % 4;
        return pick === 0 ? next() % 0x80 : 0x80 + (next() % 0x80);
      });
      expect(utf8Decode(input)).toBe(reference.decoder.decode(input));
    }
  });

  test("round-trips text longer than its internal chunk", () => {
    const text = "ab漢🙂".repeat(5000);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });
});
