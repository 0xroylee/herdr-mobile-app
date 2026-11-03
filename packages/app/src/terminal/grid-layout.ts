import type { ScreenSnapshot } from "./snapshot.ts";

export function preserveTerminalSpaces(text: string): string {
  return text.replace(/ /gu, "\u00a0");
}

export function focusRowForSnapshot(snapshot: ScreenSnapshot): number {
  let lastTextRow = -1;
  for (let index = 0; index < snapshot.rows.length; index += 1) {
    if (snapshot.rows[index]?.some((run) => /[^ ]/u.test(run.text))) lastTextRow = index;
  }

  const cursorRow = snapshot.cursor.visible ? snapshot.cursor.y : -1;
  if (lastTextRow === -1 && cursorRow === -1) return Math.max(0, snapshot.rows.length - 1);
  return Math.max(lastTextRow, cursorRow);
}

export function scrollOffsetToFocusRow(input: {
  focusRow: number;
  cellHeight: number;
  viewportHeight: number;
  contentHeight: number;
  gridOffset: number;
}): number {
  const maxOffset = Math.max(0, input.contentHeight - input.viewportHeight);
  const focusRowBottom = input.gridOffset + (input.focusRow + 1) * input.cellHeight;
  return Math.max(0, Math.min(maxOffset, focusRowBottom - input.viewportHeight));
}
