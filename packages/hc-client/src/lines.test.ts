import { describe, expect, test } from "bun:test";
import { MAX_FRAME_PAYLOAD } from "@herdr-mobile/protocol";
import { LineDecoder } from "./lines.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

function takeAll(decoder: LineDecoder): string[] {
  const out: string[] = [];
  for (let line = decoder.takeLine(); line; line = decoder.takeLine())
    out.push(utf8Decode(line.line));
  return out;
}

describe("LineDecoder", () => {
  test("keeps an incomplete line until its newline arrives", () => {
    const decoder = new LineDecoder();
    decoder.push(utf8Encode('{"id":1}'));
    expect(decoder.takeLine()).toBeUndefined();
    decoder.push(utf8Encode("\r\n"));
    expect(takeAll(decoder)).toEqual(['{"id":1}']);
  });

  test("reads LF and CRLF endings mixed in one read", () => {
    const decoder = new LineDecoder();
    decoder.push(utf8Encode("one\ntwo\r\nthree\r\n"));
    expect(takeAll(decoder)).toEqual(["one", "two", "three"]);
    expect(decoder.buffered).toBe(0);
  });

  test("handles a CR and its LF arriving in different reads", () => {
    const decoder = new LineDecoder();
    decoder.push(utf8Encode("line\r"));
    expect(decoder.takeLine()).toBeUndefined();
    decoder.push(utf8Encode("\nnext"));
    expect(takeAll(decoder)).toEqual(["line"]);
    expect(utf8Decode(decoder.drain())).toBe("next");
  });

  test("reports the bytes each line used, delimiter included", () => {
    const decoder = new LineDecoder();
    decoder.push(utf8Encode("ab\r\ncde\n"));
    expect(decoder.takeLine()?.consumed).toBe(4);
    expect(decoder.takeLine()?.consumed).toBe(4);
  });

  test("grows for a long line fed in small chunks", () => {
    const decoder = new LineDecoder();
    const text = "x".repeat(1 << 20);
    const bytes = utf8Encode(`${text}\n`);
    for (let at = 0; at < bytes.length; at += 1000) decoder.push(bytes.subarray(at, at + 1000));
    expect(takeAll(decoder)).toEqual([text]);
  });

  test("refuses a line longer than 16 MiB without a newline", () => {
    const decoder = new LineDecoder();
    decoder.push(new Uint8Array(MAX_FRAME_PAYLOAD + 1).fill(0x61));
    expect(() => decoder.takeLine()).toThrow("without a newline");
  });
});
