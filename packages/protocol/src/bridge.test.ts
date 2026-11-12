import { describe, expect, test } from "bun:test";
import { BRIDGE_WS_CLOSE_CODES } from "./bridge.ts";

describe("bridge WebSocket close codes", () => {
  test("uses the v2 handshake, record, key mismatch, busy, pairing and rotation codes", () => {
    expect(BRIDGE_WS_CLOSE_CODES).toMatchObject({
      HANDSHAKE_PROTOCOL: 1002,
      RECORD_PROTOCOL: 1008,
      IDENTITY_ROTATED: 1012,
      BUSY: 1013,
      KEY_MISMATCH: 4003,
      BAD_PAIR_CODE: 4402,
      BAD_TOKEN: 4401,
      CHILD_EXITED: 1011,
    });
  });
});
