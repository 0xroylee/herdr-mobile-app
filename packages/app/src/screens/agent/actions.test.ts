/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { DEFAULT_ZOOM, gridThatFits, resetZoom, zoomFromPinch } from "../../terminal/zoom.ts";
import {
  type AgentActionPort,
  copyAddress,
  endTerminal,
  interruptAgent,
  KEY_BAR_KEYS,
  sendKeys,
  sendMessage,
  takeOver,
} from "./actions.ts";

function createPort() {
  const calls: { method: string; args: unknown[] }[] = [];
  let confirmed = true;
  const port: AgentActionPort = {
    confirm: async (options) => {
      calls.push({ method: "confirm", args: [options] });
      return confirmed;
    },
    haptic: () => calls.push({ method: "haptic", args: [] }),
    copy: async (value) => {
      calls.push({ method: "copy", args: [value] });
    },
    sendText: async (...args) => {
      calls.push({ method: "sendText", args });
    },
    sendKeys: async (...args) => {
      calls.push({ method: "sendKeys", args });
    },
    kill: async (...args) => {
      calls.push({ method: "kill", args });
    },
    takeOver: async (...args) => {
      calls.push({ method: "takeOver", args });
    },
  };
  return {
    port,
    calls,
    setConfirmed(value: boolean) {
      confirmed = value;
    },
  };
}

describe("agent actions", () => {
  test("sends text with force only when the agent is blocked", async () => {
    const { port, calls } = createPort();

    expect(await sendMessage(port, "t7", "allow", true)).toBe(true);
    expect(await sendMessage(port, "t7", "hello", false)).toBe(true);
    expect(await sendMessage(port, "t7", "  ", false)).toBe(false);
    expect(calls.filter(({ method }) => method === "sendText")).toEqual([
      { method: "sendText", args: ["t7", "allow", true] },
      { method: "sendText", args: ["t7", "hello", false] },
    ]);
  });

  test("uses the kit's terminal key names", async () => {
    const { port, calls } = createPort();

    await sendKeys(port, "t7", ["down", "enter"]);

    expect(KEY_BAR_KEYS.map(({ key }) => key)).toEqual([
      "esc",
      "ctrl+c",
      "tab",
      "up",
      "down",
      "left",
      "right",
      "enter",
    ]);
    expect(calls.at(-1)).toEqual({ method: "sendKeys", args: ["t7", ["down", "enter"]] });
  });

  test("confirms before taking over, interrupting or ending a terminal", async () => {
    const { port, calls, setConfirmed } = createPort();
    let fitRead = false;
    const readFit = () => {
      fitRead = true;
      return { cols: 80, rows: 24 };
    };

    setConfirmed(false);
    expect(await takeOver(port, readFit)).toBe(false);
    expect(fitRead).toBe(false);
    expect(await interruptAgent(port, "t7")).toBe(false);
    expect(await endTerminal(port, "t7")).toBe(false);
    expect(
      calls.some(
        ({ method }) => method === "takeOver" || method === "sendKeys" || method === "kill",
      ),
    ).toBe(false);

    setConfirmed(true);
    expect(await takeOver(port, readFit)).toBe(true);
    expect(fitRead).toBe(true);
    expect(await interruptAgent(port, "t7")).toBe(true);
    expect(await endTerminal(port, "t7")).toBe(true);
    expect(calls).toContainEqual({ method: "takeOver", args: [80, 24] });
    expect(calls).toContainEqual({ method: "sendKeys", args: ["t7", ["ctrl+c"]] });
    expect(calls).toContainEqual({ method: "kill", args: ["t7"] });
  });

  test("carries a non-default zoom through takeover", async () => {
    const { port, calls } = createPort();
    const fit = gridThatFits({ width: 366, height: 480 }, 16);
    const defaultFit = gridThatFits({ width: 366, height: 480 }, DEFAULT_ZOOM);

    expect(fit).toEqual({ cols: 38, rows: 19 });
    expect(await takeOver(port, () => fit)).toBe(true);
    expect(calls).toContainEqual({ method: "takeOver", args: [38, 19] });
    expect(calls).not.toContainEqual({
      method: "takeOver",
      args: [defaultFit.cols, defaultFit.rows],
    });
  });

  test("keeps the zoom after takeover and lets double tap reset it", async () => {
    const { port, calls } = createPort();
    const viewport = { width: 366, height: 480 };
    const zoom = zoomFromPinch(DEFAULT_ZOOM, 1.5);
    const fit = gridThatFits(viewport, zoom);

    expect(zoom).not.toBe(DEFAULT_ZOOM);
    expect(await takeOver(port, () => gridThatFits(viewport, zoom))).toBe(true);
    expect(await takeOver(port, () => gridThatFits(viewport, zoom))).toBe(true);
    expect(calls.filter(({ method }) => method === "takeOver").map(({ args }) => args)).toEqual([
      [fit.cols, fit.rows],
      [fit.cols, fit.rows],
    ]);
    expect(gridThatFits(viewport, resetZoom())).toEqual(gridThatFits(viewport, DEFAULT_ZOOM));
  });

  test("rejects takeover when the grid has no usable fit", async () => {
    const { port, calls } = createPort();

    await expect(takeOver(port, () => undefined)).rejects.toThrow(
      "The terminal pane has no size yet",
    );
    await expect(takeOver(port, () => ({ cols: 0, rows: 0 }))).rejects.toThrow(
      "The terminal pane has no size yet",
    );
    expect(calls.filter(({ method }) => method === "takeOver")).toHaveLength(0);
  });

  test("copies the address and gives lightweight feedback", async () => {
    const { port, calls } = createPort();

    await copyAddress(port, "machine/t7");

    expect(calls).toContainEqual({ method: "copy", args: ["machine/t7"] });
    expect(calls.filter(({ method }) => method === "haptic")).toHaveLength(1);
  });
});
