import type { Status } from "@herdr-mobile/protocol";
import { claudeRecognizer } from "./prompt/claude.ts";
import { codexRecognizer } from "./prompt/codex.ts";

export interface PromptChoice {
  label: string;
  /** `terminal.keys` names that move from the highlighted row and submit. */
  keys: string[];
}

export interface Prompt {
  question: string;
  detail?: string;
  choices: PromptChoice[];
}

export interface Recognizer {
  recognize(status: Status, screen: readonly string[]): Prompt | undefined;
}

/** Recognize the active program's supported blocked dialog, if any. */
export function recognizePrompt(
  status: Status | null | undefined,
  screen: readonly string[],
): Prompt | undefined {
  if (status?.state !== "blocked") return undefined;
  for (const recognizer of recognizers) {
    const prompt = recognizer.recognize(status, screen);
    if (prompt !== undefined) return prompt;
  }
  return undefined;
}

const recognizers: readonly Recognizer[] = [claudeRecognizer, codexRecognizer];

export interface NumberedChoice {
  number: number;
  label: string;
  selected: boolean;
}

export interface NumberedChoiceBlock {
  choices: NumberedChoice[];
  firstLine: number;
}

/** Read the final contiguous numbered menu and its selected row from plain terminal text. */
export function parseNumberedChoiceBlock(
  lines: readonly string[],
): NumberedChoiceBlock | undefined {
  const parsed = lines.flatMap((raw, index) => {
    const line = stripChoiceBoxBorder(raw);
    const match = line.match(
      /^[ \t]*(?<marker>[❯›])?[ \t]*(?<number>\d+)[.)][ \t]*(?<label>\S(?:.*\S)?)\s*$/u,
    );
    if (match?.groups === undefined || match.groups.label === undefined) return [];
    const number = Number(match.groups.number);
    if (!Number.isSafeInteger(number)) return [];
    const label = match.groups.label;
    return [
      {
        index,
        marker: match.groups.marker,
        number,
        label,
        labelColumn: match[0].lastIndexOf(label),
      },
    ];
  });

  const last = parsed.at(-1);
  if (last === undefined || last.number < 2 || last.number > parsed.length) return undefined;

  const rowsByIndex = new Map(parsed.map((choice) => [choice.index, choice]));
  const group = [last];
  let current = last;
  for (let number = last.number - 1; number >= 1; number -= 1) {
    let previous: (typeof parsed)[number] | undefined;
    for (let index = current.index - 1; index >= 0; index -= 1) {
      const candidate = rowsByIndex.get(index);
      if (candidate === undefined) continue;
      if (candidate.number !== number) return undefined;
      previous = candidate;
      break;
    }
    if (previous === undefined) return undefined;

    for (let index = previous.index + 1; index < current.index; index += 1) {
      const line = stripChoiceBoxBorder(lines[index] ?? "");
      if (!isChoiceContinuation(line, previous.labelColumn)) return undefined;
    }
    group.unshift(previous);
    current = previous;
  }

  if (group.length < 2 || group.filter(({ marker }) => marker !== undefined).length !== 1)
    return undefined;

  const choices: NumberedChoice[] = [];
  for (let index = 0; index < group.length; index += 1) {
    const choice = group[index];
    if (choice === undefined) return undefined;
    const next = group[index + 1];
    const continuationEnd = next?.index ?? lines.length;
    const continuation: string[] = [];
    for (let lineIndex = choice.index + 1; lineIndex < continuationEnd; lineIndex += 1) {
      const text = stripChoiceBoxBorder(lines[lineIndex] ?? "");
      if (!isChoiceContinuation(text, choice.labelColumn)) {
        if (next !== undefined) return undefined;
        break;
      }
      continuation.push(text.trim());
    }
    choices.push({
      number: choice.number,
      label: [choice.label, ...continuation].join(" "),
      selected: choice.marker !== undefined,
    });
  }

  if (choices.some(({ label }) => label.length === 0)) return undefined;
  const firstLine = group[0]?.index;
  return firstLine === undefined ? undefined : { choices, firstLine };
}

/** Extract a question from the content immediately above a numbered menu. */
export function extractPromptQuestion(
  lines: readonly string[],
  beforeLine: number,
  allowApprovalStatement = false,
): string | undefined {
  const preceding = lines.slice(0, beforeLine);
  const boxStart = findLastIndex(preceding, isBoxStartLine);
  const source = boxStart >= 0 ? preceding.slice(boxStart + 1) : preceding.slice(-12);
  const content = source
    .map(cleanPromptLine)
    .filter((line) => line.length > 0 && !isBorderLine(line) && !isContextLine(line));
  const questionIndex = findLastIndex(content, (line) => line.includes("?"));
  if (questionIndex >= 0) {
    let start = questionIndex;
    while (start > 0 && isQuestionContinuation(content[start - 1] ?? "", content[start] ?? ""))
      start -= 1;
    const question = content
      .slice(start, questionIndex + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return question.length > 0 ? question : undefined;
  }

  if (!allowApprovalStatement) return undefined;
  const statement = content.at(-1);
  return statement !== undefined &&
    /\b(approval|required|permission|allow|run|execute)\b/i.test(statement)
    ? statement
    : undefined;
}

export function cleanPromptLine(line: string): string {
  return line
    .replace(/\r/g, "")
    .replace(/^\s*[│|]\s?/, "")
    .replace(/\s*[│|]\s*$/, "")
    .trim();
}

export function isBoxStartLine(line: string): boolean {
  return /^\s*[╭┌┏┍╔]/u.test(line);
}

export function isBorderLine(line: string): boolean {
  return /^\s*[╭╰┌└┏┗┍┕╔╚][─━┄┈═╴╶]*[╮╯┐┘┓┛┑┙╗╝]?\s*$/u.test(line);
}

export function normalizeChoiceLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

export function keysForChoice(selectedIndex: number, targetIndex: number): string[] {
  const direction = targetIndex < selectedIndex ? "up" : "down";
  const movement = Array.from({ length: Math.abs(targetIndex - selectedIndex) }, () => direction);
  return [...movement, "enter"];
}

function isContextLine(line: string): boolean {
  return /^(?:\$|\+|-|read\s|edit\s|write\s|run\s|command\s*:)/i.test(line.trim());
}

function stripChoiceBoxBorder(line: string): string {
  return line
    .replace(/\r/g, "")
    .replace(/^([ \t]*)[│|][ \t]?/, "$1")
    .replace(/[ \t]*[│|][ \t]*$/, "");
}

function isChoiceContinuation(line: string, labelColumn: number): boolean {
  if (line.trim().length === 0 || isBorderLine(line) || isChoiceRow(line)) return false;
  const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;
  return indentation >= labelColumn;
}

function isChoiceRow(line: string): boolean {
  return /^[ \t]*(?:[❯›][ \t]*)?\d+[.)][ \t]*\S/u.test(line);
}

function isQuestionContinuation(previous: string, current: string): boolean {
  if (previous.length === 0 || /[.!?]$/.test(previous)) return false;
  if (/^(?:\$|\+|-|read\s|edit\s|write\s)/i.test(previous.trim())) return false;
  return !/^\d+[.)]/.test(current.trim());
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}
