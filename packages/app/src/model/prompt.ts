import type { Status } from "@herdr-mobile/protocol";
import { claudeAdapter } from "./prompt/claude.ts";
import { codexAdapter } from "./prompt/codex.ts";
import { keysForChoice, readScreen } from "./prompt/screen.ts";

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

export interface ProgramAdapter {
  name: string;
  matches(app: string): boolean;
  isApproval(text: string): boolean;
  acceptsStatement: boolean;
  detail?(context: readonly string[]): string | undefined;
}

const MAX_QUESTION_CHARS = 300;
const adapters: readonly ProgramAdapter[] = [claudeAdapter, codexAdapter];

/** Recognize the active program's supported blocked dialog, if any. */
export function recognizePrompt(
  status: Status | null | undefined,
  screen: readonly string[],
): Prompt | undefined {
  if (status?.state !== "blocked") return undefined;
  const adapter = adapters.find(({ matches }) => matches(status.app ?? ""));
  if (adapter === undefined) return undefined;

  const dialog = readScreen(screen);
  if (dialog === undefined) return undefined;

  const question = programQuestion(status);
  const fallback = dialog.question ?? (adapter.acceptsStatement ? dialog.statement : undefined);
  const acceptedFallback =
    fallback !== undefined && fallback.length <= MAX_QUESTION_CHARS && adapter.isApproval(fallback)
      ? fallback
      : undefined;
  const selectedIndex = dialog.menu.selectedIndex;
  const choices = dialog.menu.choices.map(({ label }, index) => ({
    label,
    keys: keysForChoice(selectedIndex, index),
  }));

  const detail = adapter.detail?.(dialog.context);
  const promptQuestion = question ?? acceptedFallback ?? neutralQuestion(adapter.name, status.kind);
  return detail === undefined
    ? { question: promptQuestion, choices }
    : { question: promptQuestion, detail, choices };
}

function programQuestion(status: Status): string | undefined {
  if (typeof status.msg !== "string") return undefined;
  const sanitized = Array.from(status.msg, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  if (sanitized.length <= MAX_QUESTION_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_QUESTION_CHARS - 1)}…`;
}

function neutralQuestion(name: string, kind: Status["kind"]): string {
  switch (kind) {
    case "permission":
      return `${name} is asking for permission`;
    case "question":
      return `${name} is asking a question`;
    case "auth":
      return `${name} is asking you to sign in`;
    default:
      return `${name} is waiting for your answer`;
  }
}
