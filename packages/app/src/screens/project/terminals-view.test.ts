/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { SpaceTabRow } from "../../model/spaces.ts";
import { terminalsPresentation } from "./terminals-view.ts";

describe("Terminals screen connection presentation", () => {
  test("keeps the project pills and dims them when a connected machine reconnects", () => {
    const pills = [{ id: "tab-1", name: "Main" }] as SpaceTabRow[];
    const connected = terminalsPresentation("connected", "MacBook Pro", pills, false);
    const reconnecting = terminalsPresentation("reconnecting", "MacBook Pro", pills, false);

    expect(connected).toEqual({
      connection: { dimmed: false, banner: undefined },
      contentOpacity: 1,
      pills,
    });
    expect(reconnecting).toEqual({
      connection: {
        dimmed: true,
        banner: {
          kind: "reconnecting",
          message: "Reconnecting to MacBook Pro…",
          action: "none",
        },
      },
      contentOpacity: 0.6,
      pills,
    });
    expect(reconnecting.pills).toBe(pills);
  });
});
