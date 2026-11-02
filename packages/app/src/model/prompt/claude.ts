import type { Status } from "@herdr-mobile/protocol";
import {
  cleanPromptLine,
  extractPromptQuestion,
  isBoxStartLine,
  keysForChoice,
  type Prompt,
  parseNumberedChoiceBlock,
  type Recognizer,
} from "../prompt.ts";

export const claudeRecognizer: Recognizer = {
  recognize(status, screen) {
    return recognizeClaudePrompt(status, screen);
  },
};

export function recognizeClaudePrompt(
  status: Status,
  screen: readonly string[],
): Prompt | undefined {
  if (status.state !== "blocked" || !/claude/i.test(status.app ?? "")) return undefined;
  const block = parseNumberedChoiceBlock(screen);
  if (block === undefined) return undefined;
  const question = extractPromptQuestion(screen, block.firstLine);
  if (
    question === undefined ||
    !/\b(?:want|allow|approve|permission|edit|change|read|write|run|continue)\b/i.test(question)
  ) {
    return undefined;
  }

  const selectedIndex = block.choices.findIndex(({ selected }) => selected);
  if (selectedIndex < 0) return undefined;
  const choices = block.choices.map(({ label }, index) => ({
    label,
    keys: keysForChoice(selectedIndex, index),
  }));
  const detail = extractFileDetail(screen, block.firstLine);
  return detail === undefined ? { question, choices } : { question, detail, choices };
}

function extractFileDetail(screen: readonly string[], beforeLine: number): string | undefined {
  const preceding = screen.slice(0, beforeLine).map(cleanPromptLine);
  const boxStart = findLastIndex(preceding, isBoxStartLine);
  const dialogStart =
    boxStart >= 0 ? boxStart : findLastIndex(preceding, (line) => line.includes("?"));
  if (dialogStart < 0) return undefined;

  const headerIndex = findLastIndex(preceding.slice(0, dialogStart), (line) =>
    /^(?:read|edit|write)\s+\S/i.test(line),
  );
  if (headerIndex < 0) return undefined;

  const header = preceding[headerIndex] ?? "";
  const path = header.match(/^(?:read|edit|write)\s+(.+?)\s*$/i)?.[1]?.trim();
  if (path === undefined || path.length === 0) return undefined;

  const diffRows = preceding.slice(headerIndex + 1, dialogStart).filter((line) => line.length > 0);
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
