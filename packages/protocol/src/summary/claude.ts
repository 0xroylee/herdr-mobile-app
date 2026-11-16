import { isSummaryChrome, oneLine, stripBorder, withoutComposerRows } from "../summary.ts";

/** Extract the last visible Claude response paragraph from its screen rows. */
export function summarizeClaude(rows: readonly string[]): string | undefined {
  return lastParagraph(withoutComposerRows(rows));
}

function lastParagraph(rows: readonly string[]): string | undefined {
  const paragraphs: string[][] = [];
  let paragraph: string[] = [];
  for (const source of rows) {
    const row = stripBorder(source).replace(/^⏺\s*/, "").trim();
    if (row.length === 0) {
      if (paragraph.length > 0) paragraphs.push(paragraph);
      paragraph = [];
      continue;
    }
    if (isSummaryChrome(row)) continue;
    paragraph.push(row);
  }
  if (paragraph.length > 0) paragraphs.push(paragraph);

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const candidate = oneLine(paragraphs[index]?.join(" "));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}
