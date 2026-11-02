import { Terminal } from "@xterm/headless";
import {
  coalesceRuns,
  defaultTerminalColor,
  type ScreenRow,
  type ScreenRun,
  type ScreenSnapshot,
  type TerminalColor,
} from "./snapshot.ts";

type BufferLine = NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>;

export interface TerminalModel {
  write(bytes: Uint8Array, done: () => void): void;
  resize(cols: number, rows: number): void;
  snapshot(): ScreenSnapshot;
  dispose(): void;
}

function rgbColor(value: number): TerminalColor {
  return {
    kind: "rgb",
    hex: `#${value.toString(16).padStart(6, "0")}`,
  };
}

function readRow(line: BufferLine | undefined, cols: number): ScreenRow {
  if (!line) return [];

  const cellData = line.getCell(0);
  if (!cellData) return [];

  const cells: ScreenRun[] = [];
  let lastMeaningfulCell = -1;

  for (let column = 0; column < cols; ) {
    const cell = line.getCell(column, cellData);
    if (!cell) {
      cells.push({
        text: " ",
        fg: defaultTerminalColor,
        bg: defaultTerminalColor,
        bold: false,
        inverse: false,
      });
      lastMeaningfulCell = cells.length - 1;
      column += 1;
      continue;
    }

    const width = cell.getWidth();
    if (width === 0) {
      column += 1;
      continue;
    }

    const bold = cell.isBold() !== 0;
    let fg: TerminalColor;
    if (cell.isFgDefault()) {
      fg = defaultTerminalColor;
    } else if (cell.isFgRGB()) {
      fg = rgbColor(cell.getFgColor());
    } else {
      const index = cell.getFgColor();
      fg = { kind: "ansi", index: bold && index < 8 ? index + 8 : index };
    }

    let bg: TerminalColor;
    if (cell.isBgDefault()) {
      bg = defaultTerminalColor;
    } else if (cell.isBgRGB()) {
      bg = rgbColor(cell.getBgColor());
    } else {
      bg = { kind: "ansi", index: cell.getBgColor() };
    }

    const text = cell.getChars() || " ";
    const inverse = cell.isInverse() !== 0;
    cells.push({ text, fg, bg, bold, inverse });

    if (text !== " " || fg.kind !== "default" || bg.kind !== "default" || bold || inverse) {
      lastMeaningfulCell = cells.length - 1;
    }

    column += width;
  }

  return coalesceRuns(cells.slice(0, lastMeaningfulCell + 1));
}

export function createTerminalModel(cols = 80, rows = 24): TerminalModel {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  let cursorVisible = true;
  const cursorVisibilityHandlers = [
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.some((param) => param === 25)) cursorVisible = true;
      return false;
    }),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.some((param) => param === 25)) cursorVisible = false;
      return false;
    }),
    terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      cursorVisible = true;
      return false;
    }),
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      cursorVisible = true;
      return false;
    }),
  ];

  return {
    write(bytes, done) {
      terminal.write(bytes, done);
    },
    resize(nextCols, nextRows) {
      terminal.resize(nextCols, nextRows);
    },
    snapshot() {
      const buffer = terminal.buffer.active;
      const snapshotRows: ScreenRow[] = [];

      for (let y = buffer.baseY; y < buffer.baseY + terminal.rows; y += 1) {
        snapshotRows.push(readRow(buffer.getLine(y), terminal.cols));
      }

      return {
        cols: terminal.cols,
        rows: snapshotRows,
        cursor: {
          x: Math.min(buffer.cursorX, terminal.cols - 1),
          y: Math.min(buffer.cursorY, terminal.rows - 1),
          visible: cursorVisible,
        },
      };
    },
    dispose() {
      for (const handler of cursorVisibilityHandlers) handler.dispose();
      terminal.dispose();
    },
  };
}
