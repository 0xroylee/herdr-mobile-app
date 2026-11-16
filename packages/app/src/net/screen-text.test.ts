/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { HcMethod, HcParams, HcResult } from "@herdr-mobile/protocol";
import type { ConnectionManager } from "./connection.ts";
import { createScreenText } from "./screen-text.ts";

describe("ScreenText", () => {
  test("reuses rows for the same address, turn and status state", async () => {
    const calls: string[] = [];
    const screenText = createScreenText(
      fakeManager(async (method, _params) => {
        calls.push(method);
        return { complete: true, how: "screen", text: "first\nsecond" } as HcResult<typeof method>;
      }),
    );

    await expect(screenText.read("t7", { turn: 2, state: "done" })).resolves.toEqual([
      "first",
      "second",
    ]);
    await expect(screenText.read("t7", { turn: 2, state: "done" })).resolves.toEqual([
      "first",
      "second",
    ]);

    expect(calls).toEqual(["terminal.read"]);
  });

  test("refetches when the turn or status state changes", async () => {
    const calls: unknown[] = [];
    const screenText = createScreenText(
      fakeManager(async (method, params) => {
        calls.push({ method, params });
        return { complete: true, how: "screen", text: `turn ${calls.length}` } as HcResult<
          typeof method
        >;
      }),
    );

    await screenText.read("t7", { turn: 1, state: "done" });
    await screenText.read("t7", { turn: 2, state: "done" });
    await screenText.read("t7", { turn: 2, state: "working" });
    screenText.invalidate("t7");
    await screenText.read("t7", { turn: 2, state: "working" });

    expect(calls).toHaveLength(4);
  });

  test("shares one in-flight read for each cache key", async () => {
    let resolveRead!: (value: HcResult<"terminal.read">) => void;
    let count = 0;
    const screenText = createScreenText(
      fakeManager(() => {
        count += 1;
        return new Promise<HcResult<"terminal.read">>((resolve) => {
          resolveRead = resolve;
        });
      }),
    );

    const first = screenText.read("t7", { turn: 3, state: "blocked" });
    const second = screenText.read("t7", { turn: 3, state: "blocked" });
    expect(count).toBe(1);
    resolveRead({ complete: true, how: "screen", text: "pending" });
    await expect(Promise.all([first, second])).resolves.toEqual([["pending"], ["pending"]]);
  });
});

function fakeManager(
  call: <M extends HcMethod>(method: M, params: HcParams<M>) => Promise<HcResult<M>>,
): Pick<ConnectionManager, "call"> {
  return { call };
}
