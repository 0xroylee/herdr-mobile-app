/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { ensureXtermEnvironment } from "./xterm-environment.ts";

const xtermSource = readFileSync(
  new URL(
    "../../../../node_modules/@xterm/headless/lib-headless/xterm-headless.js",
    import.meta.url,
  ),
  "utf8",
);

type HeadlessTerminal = {
  buffer: {
    active: {
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  dispose(): void;
  write(data: string, callback?: () => void): void;
};

type HeadlessModule = {
  Terminal: new (options: {
    allowProposedApi: boolean;
    cols: number;
    rows: number;
  }) => HeadlessTerminal;
};

function makeReactNativeContext() {
  return createContext({
    clearTimeout,
    exports: {},
    navigator: { product: "ReactNative" },
    performance,
    process: { env: {} },
    setTimeout,
    window: {},
  });
}

describe("xterm environment", () => {
  test("reproduces the @xterm/headless includes crash with React Native globals", () => {
    const context = makeReactNativeContext();
    let thrown: unknown;

    try {
      runInContext(xtermSource, context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "TypeError",
      message: expect.stringContaining("includes"),
    });
  });

  test("loads xterm and reads written text after preparing React Native globals", async () => {
    const context = makeReactNativeContext();
    ensureXtermEnvironment(context);
    runInContext(xtermSource, context);

    const { Terminal } = runInContext("exports", context) as HeadlessModule;
    const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });

    try {
      await new Promise<void>((resolve) => terminal.write("hello from React Native", resolve));

      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
        "hello from React Native",
      );
    } finally {
      terminal.dispose();
    }
  });

  test("keeps existing navigator strings", () => {
    const context = {
      navigator: { platform: "Custom Platform", userAgent: "Custom User Agent" },
    };

    ensureXtermEnvironment(context);

    expect(context.navigator).toEqual({
      platform: "Custom Platform",
      userAgent: "Custom User Agent",
    });
  });
});
