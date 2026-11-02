import type { TerminalColor } from "./snapshot.ts";

export type TerminalTheme = "graphite" | "paper";

export interface TerminalPalette {
  readonly ansi: readonly string[];
  readonly selection: string;
  readonly cursor: "term-fg";
}

export const terminalPalettes: Record<TerminalTheme, TerminalPalette> = {
  graphite: {
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
  },
  paper: {
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
  },
};

const extendedLevels = [0, 95, 135, 175, 215, 255] as const;

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function terminalColorHex(
  color: TerminalColor,
  palette: TerminalPalette,
): string | undefined {
  if (color.kind === "default") return undefined;
  if (color.kind === "rgb") return color.hex;

  const { index } = color;
  if (index >= 0 && index < palette.ansi.length) return palette.ansi[index];
  if (index >= 16 && index <= 231) {
    const colorIndex = index - 16;
    const red = extendedLevels[Math.floor(colorIndex / 36)];
    const green = extendedLevels[Math.floor((colorIndex % 36) / 6)];
    const blue = extendedLevels[colorIndex % 6];
    return rgbHex(red, green, blue);
  }
  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return rgbHex(gray, gray, gray);
  }

  return undefined;
}
