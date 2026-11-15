/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { ConnectionState } from "@/store/core.ts";

mock.module("@/store/platform.ts", () => ({
  machinesStore: { getState: () => ({ activeId: null, machines: {} }) },
}));

const { connectionPresentation } = await import("./connectionPresentation.ts");
type SpacesConnectionPresentation =
  import("./connectionPresentation.ts").SpacesConnectionPresentation;

const expected: Record<ConnectionState, SpacesConnectionPresentation> = {
  connected: { dimmed: false, banner: undefined },
  connecting: {
    dimmed: true,
    banner: { kind: "reconnecting", message: "Connecting to MacBook Pro…", action: "none" },
  },
  reconnecting: {
    dimmed: true,
    banner: { kind: "reconnecting", message: "Reconnecting to MacBook Pro…", action: "none" },
  },
  offline: {
    dimmed: true,
    banner: {
      kind: "offline",
      message: "Can't reach the bridge. Check that Tailscale is on.",
      action: "retry",
    },
  },
  unauthorized: {
    dimmed: true,
    banner: {
      kind: "unauthorized",
      message: "This device is no longer paired with MacBook Pro.",
      action: "pair",
    },
  },
  identity_changed: {
    dimmed: true,
    banner: {
      kind: "unauthorized",
      message: "This Mac's bridge identity changed.",
      action: "pair",
    },
  },
};

describe("connectionPresentation", () => {
  for (const [state, presentation] of Object.entries(expected) as [
    ConnectionState,
    SpacesConnectionPresentation,
  ][]) {
    test(`presents ${state} explicitly`, () => {
      expect(connectionPresentation(state, "MacBook Pro")).toEqual(presentation);
    });
  }

  test("shows no banner and does not dim when there is no active connection", () => {
    expect(connectionPresentation(undefined, undefined)).toEqual({
      dimmed: false,
      banner: undefined,
    });
  });

  test("uses Mac when the machine name is blank", () => {
    expect(connectionPresentation("connecting", "  ").banner).toEqual({
      kind: "reconnecting",
      message: "Connecting to Mac…",
      action: "none",
    });
  });

  test("uses the secure-route offline copy when that route is available", () => {
    expect(connectionPresentation("offline", "MacBook Pro", true).banner).toEqual({
      kind: "offline",
      message: "Can't reach your Mac. Check it's awake and online.",
      action: "retry",
    });
  });
});
