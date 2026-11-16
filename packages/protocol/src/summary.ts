import type { Status } from "./generated/hc-api.ts";
import { summarizeClaude } from "./summary/claude.ts";
import { summarizeCodex } from "./summary/codex.ts";

const SUMMARY_MAX_CHARS = 160;

/** Choose a task summary from the status message, a program adapter, or the last screen line. */
export function summarize(
  programKey: string,
  status: Status | null | undefined,
  rows: readonly string[],
): string | undefined {
  const statusMessage = oneLine(status?.msg);
  if (statusMessage !== undefined) return statusMessage;

  const visibleRows = withoutComposerRows(rows);
  const adapted =
    programKey === "claude"
      ? summarizeClaude(visibleRows)
      : programKey === "codex"
        ? summarizeCodex(visibleRows)
        : undefined;
  if (adapted !== undefined) return oneLine(adapted);

  for (let index = visibleRows.length - 1; index >= 0; index -= 1) {
    const line = stripBorder(visibleRows[index] ?? "");
    if (line.length === 0 || isSummaryChrome(line)) continue;
    return oneLine(line);
  }
  return undefined;
}

/** Remove the composer prompt and its wrapped, vertically bordered rows. */
export function withoutComposerRows(rows: readonly string[]): string[] {
  const visible: string[] = [];
  let composerBoxOpen = false;

  for (const source of rows) {
    const row = stripBorder(source);
    const boxed = /^[ \t]*[│|]/u.test(source);
    if (composerBoxOpen) {
      if (boxed || isBorder(row)) {
        if (/^[╰└┗]/u.test(row.trim())) composerBoxOpen = false;
        continue;
      }
      composerBoxOpen = false;
    }

    if (/^(?:[>❯›]+\s*|write a message\b)/i.test(row.trim())) {
      composerBoxOpen = boxed;
      continue;
    }
    visible.push(source);
  }

  return visible;
}

export function oneLine(value: string | undefined): string | undefined {
  const normalized =
    value === undefined
      ? undefined
      : Array.from(value, (character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
        })
          .join("")
          .replace(/\s+/g, " ")
          .trim();
  if (normalized === undefined || normalized.length === 0) return undefined;
  const characters = Array.from(normalized);
  if (characters.length <= SUMMARY_MAX_CHARS) return normalized;
  return `${characters
    .slice(0, SUMMARY_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

/** Remove a TUI's visible left and right cell borders without changing row content. */
export function stripBorder(value: string): string {
  return value
    .replace(/^[ \t]*[│|][ \t]?/, "")
    .replace(/[ \t]*[│|][ \t]*$/, "")
    .trim();
}

export function isBorder(value: string): boolean {
  return /^[╭╮╰╯┌┐└┘├┤┬┴┼│|╎╏─━┄┈═]+$/u.test(value.trim());
}

/** Recognize full status, prompt, activity and border rows from supported terminal screens. */
export function isSummaryChrome(value: string): boolean {
  const row = value.trim();
  return (
    isBorder(row) ||
    /^[╭╰┌└┏┗]/u.test(row) ||
    /^(?:[>❯›]+\s*|write a message\b|esc to interrupt|ctrl\+c to (?:interrupt|exit)|tokens?\b|gpt-[^ ]+\s+(?:high|medium|low)\b|codex\s+\d|thinking(?:\.{1,3})?$|working(?:\.{1,3})?$|\?\s+for shortcuts|⏵⏵\s|✻\s+(?:cooked|worked|thought)\b|\[?\s*\d+%\s*\]?\s*$|bypass permissions\b|accept edits\b)/i.test(
      row,
    )
  );
}
