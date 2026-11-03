import type { Status } from "@herdr-mobile/protocol";
import type { Prompt, Recognizer } from "../prompt.ts";
import { type Dialog, keysForChoice } from "./dialog.ts";

export const claudeRecognizer: Recognizer = {
  recognize(status, dialog) {
    return recognizeClaudePrompt(status, dialog);
  },
};

export function recognizeClaudePrompt(status: Status, dialog: Dialog): Prompt | undefined {
  if (status.state !== "blocked" || !/claude/i.test(status.app ?? "")) return undefined;
  const question = dialog.question;
  if (
    question === undefined ||
    !/\b(?:want|allow|approve|permission|edit|change|read|write|run|continue)\b/i.test(question)
  ) {
    return undefined;
  }

  const choices = dialog.menu.choices.map(({ label }, index) => ({
    label,
    keys: keysForChoice(dialog.menu.selectedIndex, index),
  }));
  const detail = extractFileDetail(dialog.preceding);
  return detail === undefined ? { question, choices } : { question, detail, choices };
}

function extractFileDetail(precedingRows: readonly string[]): string | undefined {
  const preceding = precedingRows.map((line) => line.replace(/\r/g, "").trim());
  const headerIndex = findLastIndex(preceding, (line) => /^(?:read|edit|write)\s+\S/i.test(line));
  if (headerIndex < 0) return undefined;

  const header = preceding[headerIndex] ?? "";
  const path = header.match(/^(?:read|edit|write)\s+(.+?)\s*$/i)?.[1]?.trim();
  if (path === undefined || path.length === 0) return undefined;

  const diffRows = preceding.slice(headerIndex + 1).filter((line) => line.length > 0);
  if (diffRows.some((line) => !/^\+(?!\+)|^-(?!-)/.test(line))) return undefined;
  if (diffRows.length === 0) return path;

  const additions = diffRows.filter((line) => /^\+(?!\+)/.test(line)).length;
  const removals = diffRows.filter((line) => /^-(?!-)/.test(line)).length;
  return `${path} · +${additions} −${removals}`;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}
