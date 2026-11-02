import { describe, expect, test } from "bun:test";
import {
  FRAME_HEADER_BYTES,
  type Frame,
  FrameKind,
  MAX_FRAME_PAYLOAD,
} from "@herdr-mobile/protocol";
import {
  decodeClose,
  decodeCredit,
  decodeFacts,
  decodeFocus,
  decodeResize,
  encodeClose,
  encodeCredit,
  encodeFacts,
  encodeFocus,
  encodeFrame,
  encodeResize,
  FrameDecoder,
} from "./frame.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Records every payload request. An oversized request gets harmless empty storage. */
function recordingAllocator() {
  const requests: number[] = [];
  const allocatePayload = (byteLength: number) => {
    requests.push(byteLength);
    return byteLength > MAX_FRAME_PAYLOAD ? new Uint8Array(0) : new Uint8Array(byteLength);
  };
  return { requests, allocatePayload };
}

function header(channel: number, kind: number, length: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, channel, true);
  view.setUint8(4, kind);
  view.setUint32(5, length, true);
  return out;
}

const frameA: Frame = { channel: 1, kind: FrameKind.Data, payload: ascii("hello") };
const frameB: Frame = { channel: 0, kind: 9, payload: new Uint8Array(0) };
const frameC: Frame = {
  channel: 3,
  kind: FrameKind.Resize,
  payload: bytes(0x50, 0x00, 0x18, 0x00),
};
const expected = [frameA, frameB, frameC];
const stream = concat(encodeFrame(frameA), encodeFrame(frameB), encodeFrame(frameC));

function decodeInParts(parts: Uint8Array[]): Frame[] {
  const decoder = new FrameDecoder();
  const frames = parts.flatMap((part) => decoder.push(part));
  decoder.finish();
  return frames;
}

describe("encodeFrame", () => {
  test("writes channel and length little-endian around the kind byte", () => {
    const frame = encodeFrame({
      channel: 0x01020304,
      kind: FrameKind.Data,
      payload: bytes(0xaa, 0xbb),
    });
    expect(frame).toEqual(bytes(0x04, 0x03, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb));
  });

  test("keeps unsigned values above 2^31", () => {
    const frame = encodeFrame({ channel: 0xfffffffe, kind: 0xff, payload: new Uint8Array(0) });
    expect(frame).toEqual(bytes(0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00));
    expect(new FrameDecoder().push(frame)).toEqual([
      { channel: 4294967294, kind: 255, payload: new Uint8Array(0) },
    ]);
  });

  test("round-trips herdr-core's channel 7 DATA frame", () => {
    const frame = encodeFrame({ channel: 7, kind: FrameKind.Data, payload: ascii("hi") });
    const view = new DataView(frame.buffer);
    expect([view.getUint32(0, true), view.getUint8(4), view.getUint32(5, true)]).toEqual([7, 0, 2]);
    expect(frame.subarray(FRAME_HEADER_BYTES)).toEqual(ascii("hi"));
  });

  test("accepts exactly 16 MiB and rejects one byte more", () => {
    const atCap = encodeFrame({
      channel: 1,
      kind: FrameKind.Data,
      payload: new Uint8Array(MAX_FRAME_PAYLOAD),
    });
    expect(atCap.length).toBe(FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD);
    expect(() =>
      encodeFrame({
        channel: 1,
        kind: FrameKind.Data,
        payload: new Uint8Array(MAX_FRAME_PAYLOAD + 1),
      }),
    ).toThrow("frame of 16777217 bytes exceeds 16777216");
  });

  test("rejects channels and kinds outside their widths", () => {
    const payload = new Uint8Array(0);
    for (const channel of [-1, 2 ** 32, 1.5]) {
      expect(() => encodeFrame({ channel, kind: 0, payload })).toThrow("is not a u32");
    }
    for (const kind of [-1, 256, 0.5]) {
      expect(() => encodeFrame({ channel: 0, kind, payload })).toThrow("is not a u8");
    }
  });
});

describe("FrameDecoder", () => {
  test("decodes the literal little-endian vector", () => {
    const literal = bytes(0x04, 0x03, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb);
    expect(new FrameDecoder().push(literal)).toEqual([
      { channel: 0x01020304, kind: 0, payload: bytes(0xaa, 0xbb) },
    ]);
  });

  test("rejects an oversized header before asking for any payload storage", () => {
    const { requests, allocatePayload } = recordingAllocator();
    const decoder = new FrameDecoder({ allocatePayload });
    expect(() => decoder.push(header(1, FrameKind.Data, MAX_FRAME_PAYLOAD + 1))).toThrow(
      "frame of 16777217 bytes exceeds 16777216",
    );
    expect(requests).toEqual([]);
  });

  test("rejects herdr-core's u32::MAX length header", () => {
    expect(() => new FrameDecoder().push(header(0, 0, 0xffffffff))).toThrow(
      "frame of 4294967295 bytes exceeds 16777216",
    );
  });

  test("stays failed after a bad header", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header(0, 0, MAX_FRAME_PAYLOAD + 1))).toThrow("exceeds");
    expect(() => decoder.push(encodeFrame(frameA))).toThrow("exceeds");
    expect(() => decoder.finish()).toThrow("exceeds");
  });

  test("accepts a payload of exactly 16 MiB with one allocation", () => {
    const { requests, allocatePayload } = recordingAllocator();
    const decoder = new FrameDecoder({ allocatePayload });
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD);
    payload[0] = 1;
    payload[MAX_FRAME_PAYLOAD - 1] = 2;
    const half = MAX_FRAME_PAYLOAD / 2;
    expect(decoder.push(header(5, FrameKind.Data, MAX_FRAME_PAYLOAD))).toEqual([]);
    expect(decoder.push(payload.subarray(0, half))).toEqual([]);
    const [frame] = decoder.push(payload.subarray(half));
    expect(frame?.payload.length).toBe(MAX_FRAME_PAYLOAD);
    expect([frame?.payload[0], frame?.payload[MAX_FRAME_PAYLOAD - 1]]).toEqual([1, 2]);
    expect(requests).toEqual([MAX_FRAME_PAYLOAD]);
  });

  test("returns every complete frame from one read, in order", () => {
    expect(new FrameDecoder().push(stream)).toEqual(expected);
  });

  test("decodes every two-part split", () => {
    for (let i = 1; i < stream.length; i++) {
      expect(decodeInParts([stream.subarray(0, i), stream.subarray(i)])).toEqual(expected);
    }
  });

  test("decodes every three-part partition", () => {
    for (let i = 1; i < stream.length - 1; i++) {
      for (let j = i + 1; j < stream.length; j++) {
        const parts = [stream.subarray(0, i), stream.subarray(i, j), stream.subarray(j)];
        expect(decodeInParts(parts)).toEqual(expected);
      }
    }
  });

  test("decodes one byte at a time", () => {
    const parts = Array.from(stream, (_, i) => stream.subarray(i, i + 1));
    expect(decodeInParts(parts)).toEqual(expected);
  });

  test("reads only the bytes inside an offset view", () => {
    const padded = new Uint8Array(stream.length + 10).fill(0xee);
    padded.set(stream, 5);
    const view = new Uint8Array(padded.buffer, 5, stream.length);
    expect(new FrameDecoder().push(view)).toEqual(expected);
    for (let i = 1; i < stream.length; i++) {
      const first = new Uint8Array(padded.buffer, 5, i);
      const rest = new Uint8Array(padded.buffer, 5 + i, stream.length - i);
      expect(decodeInParts([first, rest])).toEqual(expected);
    }
  });

  test("copies payloads, so reusing the read buffer doesn't change them", () => {
    const buffer = stream.slice();
    const frames = new FrameDecoder().push(buffer);
    buffer.fill(0);
    expect(frames).toEqual(expected);
  });

  test("keeps unknown kinds and empty payloads", () => {
    expect(new FrameDecoder().push(encodeFrame(frameB))).toEqual([frameB]);
  });

  test("finish reports a cut-off header or payload", () => {
    const partialHeader = new FrameDecoder();
    partialHeader.push(stream.subarray(0, 3));
    expect(() => partialHeader.finish()).toThrow("truncated frame header: 3 of 9 bytes");

    const partialPayload = new FrameDecoder();
    partialPayload.push(stream.subarray(0, FRAME_HEADER_BYTES + 2));
    expect(() => partialPayload.finish()).toThrow("truncated frame payload: 2 of 5 bytes");

    const complete = new FrameDecoder();
    complete.push(stream);
    expect(() => complete.finish()).not.toThrow();
  });
});

describe("control payloads", () => {
  test("RESIZE is cols then rows, u16 little-endian", () => {
    expect(encodeResize(80, 24)).toEqual(bytes(0x50, 0x00, 0x18, 0x00));
    expect(encodeResize(300, 513)).toEqual(bytes(0x2c, 0x01, 0x01, 0x02));
    expect(decodeResize(bytes(0x2c, 0x01, 0x01, 0x02))).toEqual({ cols: 300, rows: 513 });
    expect(() => encodeResize(65536, 1)).toThrow("out of range");
    expect(() => decodeResize(bytes(0x50, 0x00))).toThrow("RESIZE payload has 2 bytes, expected 4");
  });

  test("CREDIT is a u32 little-endian byte count", () => {
    expect(encodeCredit(0x01020304)).toEqual(bytes(0x04, 0x03, 0x02, 0x01));
    expect(decodeCredit(encodeCredit(0xffffffff))).toBe(0xffffffff);
    expect(() => encodeCredit(-1)).toThrow("out of range");
    expect(() => encodeCredit(2 ** 32)).toThrow("out of range");
    expect(() => decodeCredit(bytes(1, 2, 3))).toThrow("CREDIT payload has 3 bytes, expected 4");
  });

  test("FOCUS is one byte, 1 or 0", () => {
    expect(encodeFocus(true)).toEqual(bytes(1));
    expect(encodeFocus(false)).toEqual(bytes(0));
    expect(decodeFocus(bytes(1))).toBe(true);
    expect(decodeFocus(bytes(0))).toBe(false);
    expect(() => decodeFocus(bytes(2))).toThrow("neither 0 nor 1");
    expect(() => decodeFocus(bytes(1, 0))).toThrow("FOCUS payload has 2 bytes, expected 1");
  });

  test("CLOSE is empty from a client and keeps the core's whole JSON reason", () => {
    expect(encodeClose()).toEqual(new Uint8Array(0));
    expect(decodeClose(new Uint8Array(0))).toBeUndefined();
    const reason = { reason: "exited", exit_code: null, signal: 15, detail: { fixture: true } };
    expect(decodeClose(encodeClose(reason))).toEqual(reason);
    expect(decodeClose(ascii('{"reason":"exited","exit_code":0,"signal":null}'))).toEqual({
      reason: "exited",
      exit_code: 0,
      signal: null,
    });
  });

  test("FACTS is JSON, including text outside ASCII", () => {
    const display = { bg: "#1e1e2e", cell: [8, 16], font: "Menlo é 漢 🙂" };
    expect(decodeFacts(encodeFacts(display))).toEqual(display);
    expect(encodeFacts(display)).toEqual(new TextEncoder().encode(JSON.stringify(display)));
  });
});
