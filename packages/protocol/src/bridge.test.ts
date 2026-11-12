import { describe, expect, test } from "bun:test";
import type { AuthReply } from "./bridge.ts";
import { BRIDGE_WS_CLOSE_CODES } from "./bridge.ts";

const authReply: AuthReply = {
  v: 1,
  ok: true,
  role: "control",
  machine: { id: "machine-1", name: "Mac" },
  routes: { direct: "https://mac.tailnet.ts.net" },
  bridgeKey: "a".repeat(43),
};

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

  test("auth replies carry advertised routes and the bridge identity key", () => {
    expect(authReply).toMatchObject({
      routes: { direct: "https://mac.tailnet.ts.net" },
      bridgeKey: "a".repeat(43),
    });
  });
});
