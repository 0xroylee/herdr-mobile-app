/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { createTerminalModel, type TerminalModel } from "./model.ts";
import { terminalPalettes } from "./palette.ts";
import { screenTextRows } from "./snapshot.ts";

const encoder = new TextEncoder();
const defaultColor = { kind: "default" } as const;
const models: TerminalModel[] = [];

function makeModel(cols = 12, rows = 3): TerminalModel {
  const model = createTerminalModel(cols, rows);
  models.push(model);
  return model;
}

function write(model: TerminalModel, text: string): Promise<void> {
  return new Promise((resolve) => model.write(encoder.encode(text), resolve));
}

afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
});

test("uses the kit's graphite and paper ANSI palettes, selection, and cursor", () => {
  expect(terminalPalettes.graphite).toEqual({
    ansi: [
      "#454c59",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#abb2bf",
      "#767676",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#e6e7e9",
    ],
    selection: "#264f78",
    cursor: "term-fg",
  });
  expect(terminalPalettes.paper).toEqual({
    ansi: [
      "#383a42",
      "#e45649",
      "#50a14f",
      "#c18401",
      "#4078f2",
      "#a626a4",
      "#0184bc",
      "#a0a1a7",
      "#696c77",
      "#ca1243",
      "#448c27",
      "#986801",
      "#2f5af3",
      "#7f1d9e",
      "#0b7a9e",
      "#252b37",
    ],
    selection: "#cfe0ff",
    cursor: "term-fg",
  });
});

test("snapshots ANSI foreground and background colors and promotes bold colors", async () => {
  const model = makeModel();
  await write(model, "\u001b[31mR\u001b[1mB\u001b[7mI\u001b[0m\u001b[44;32mC");

  const row = model.snapshot().rows[0];
  expect(row).toEqual([
    {
      text: "R",
      fg: { kind: "ansi", index: 1 },
      bg: { kind: "default" },
      bold: false,
      inverse: false,
    },
    {
      text: "B",
      fg: { kind: "ansi", index: 9 },
      bg: { kind: "default" },
      bold: true,
      inverse: false,
    },
    {
      text: "I",
      fg: { kind: "ansi", index: 9 },
      bg: { kind: "default" },
      bold: true,
      inverse: true,
    },
    {
      text: "C",
      fg: { kind: "ansi", index: 2 },
      bg: { kind: "ansi", index: 4 },
      bold: false,
      inverse: false,
    },
  ]);
  expect(screenTextRows(model.snapshot())[0]).toBe("RBIC");
});

test("preserves true-color foregrounds", async () => {
  const model = makeModel();
  await write(model, "\u001b[38;2;12;34;56mT");

  expect(model.snapshot().rows[0][0]).toEqual({
    text: "T",
    fg: { kind: "rgb", hex: "#0c2238" },
    bg: { kind: "default" },
    bold: false,
    inverse: false,
  });
});

test("resizes the xterm buffer and reports the new dimensions", () => {
  const model = makeModel();
  model.resize(20, 5);

  const snapshot = model.snapshot();
  expect(snapshot.cols).toBe(20);
  expect(snapshot.rows).toHaveLength(5);
  expect(snapshot.cursor).toEqual({ x: 0, y: 0, visible: true });
});

test("calls the credit callback after xterm has parsed the bytes", async () => {
  const model = makeModel();
  const order: string[] = [];
  const credited = new Promise<void>((resolve) => {
    model.write(encoder.encode("painted"), () => {
      expect(screenTextRows(model.snapshot())[0]).toBe("painted");
      order.push("credit");
      resolve();
    });
  });

  expect(order).toEqual([]);
  await credited;
  expect(order).toEqual(["credit"]);
});

test("tracks cursor visibility when DECTCEM hides and shows it", async () => {
  const model = makeModel();

  await write(model, "\u001b[?25l");
  expect(model.snapshot().cursor.visible).toBe(false);

  await write(model, "\u001b[?25h");
  expect(model.snapshot().cursor.visible).toBe(true);
});

test("shows the cursor again after a full reset", async () => {
  const model = makeModel();

  await write(model, "\u001b[?25l\u001bc");

  expect(model.snapshot().cursor.visible).toBe(true);
});

test("shows the cursor again after a soft reset", async () => {
  const model = makeModel();

  await write(model, "\u001b[?25l\u001b[!p");

  expect(model.snapshot().cursor.visible).toBe(true);
});

test("keeps wide characters in row order with their styles and cell columns", async () => {
  const model = makeModel(8, 2);
  await write(model, "\u001b[31mA界B");

  const snapshot = model.snapshot();
  expect(screenTextRows(snapshot)).toEqual(["A界B", ""]);
  expect(snapshot.rows[0]).toEqual([
    { text: "A界B", fg: { kind: "ansi", index: 1 }, bg: defaultColor, bold: false, inverse: false },
  ]);
  expect(snapshot.cursor).toEqual({ x: 4, y: 0, visible: true });
});

test("keeps combining characters attached to their base cell", async () => {
  const model = makeModel(8, 2);
  await write(model, "e\u0301X");

  const snapshot = model.snapshot();
  expect(screenTextRows(snapshot)).toEqual(["e\u0301X", ""]);
  expect(snapshot.rows[0]).toEqual([
    { text: "e\u0301X", fg: defaultColor, bg: defaultColor, bold: false, inverse: false },
  ]);
  expect(snapshot.cursor).toEqual({ x: 2, y: 0, visible: true });
});

test("preserves an empty row between rows with text", async () => {
  const model = makeModel(12, 4);
  await write(model, "top\r\n\r\nbottom");

  const snapshot = model.snapshot();
  expect(screenTextRows(snapshot)).toEqual(["top", "", "bottom", ""]);
  expect(snapshot.rows[0]).toEqual([
    { text: "top", fg: defaultColor, bg: defaultColor, bold: false, inverse: false },
  ]);
  expect(snapshot.rows[1]).toEqual([]);
  expect(snapshot.rows[2]).toEqual([
    { text: "bottom", fg: defaultColor, bg: defaultColor, bold: false, inverse: false },
  ]);
  expect(snapshot.cursor).toEqual({ x: 6, y: 2, visible: true });
});

test("retains the style of colored trailing blanks", async () => {
  const model = makeModel(8, 2);
  await write(model, "A\u001b[44m   \u001b[0m");

  const snapshot = model.snapshot();
  expect(screenTextRows(snapshot)).toEqual(["A", ""]);
  expect(snapshot.rows[0]).toEqual([
    { text: "A", fg: defaultColor, bg: defaultColor, bold: false, inverse: false },
    { text: "   ", fg: defaultColor, bg: { kind: "ansi", index: 4 }, bold: false, inverse: false },
  ]);
  expect(snapshot.cursor).toEqual({ x: 4, y: 0, visible: true });
});

test("wraps text written at the last column onto the following row", async () => {
  const model = makeModel(5, 3);
  await write(model, "\u001b[31mABCDEZ");

  const snapshot = model.snapshot();
  expect(screenTextRows(snapshot)).toEqual(["ABCDE", "Z", ""]);
  expect(snapshot.rows[0]).toEqual([
    {
      text: "ABCDE",
      fg: { kind: "ansi", index: 1 },
      bg: defaultColor,
      bold: false,
      inverse: false,
    },
  ]);
  expect(snapshot.rows[1]).toEqual([
    { text: "Z", fg: { kind: "ansi", index: 1 }, bg: defaultColor, bold: false, inverse: false },
  ]);
  expect(snapshot.cursor).toEqual({ x: 1, y: 1, visible: true });
});
