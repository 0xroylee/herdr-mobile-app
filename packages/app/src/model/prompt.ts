import type { Status } from "@herdr-mobile/protocol";
import { claudeRecognizer } from "./prompt/claude.ts";
import { codexRecognizer } from "./prompt/codex.ts";
import { type Dialog, readDialog } from "./prompt/dialog.ts";

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
  recognize(status: Status, dialog: Dialog): Prompt | undefined;
}

/** Recognize the active program's supported blocked dialog, if any. */
export function recognizePrompt(
  status: Status | null | undefined,
  screen: readonly string[],
): Prompt | undefined {
  if (status?.state !== "blocked") return undefined;
  const dialog = readDialog(screen);
  if (dialog === undefined) return undefined;
  for (const recognizer of recognizers) {
    const prompt = recognizer.recognize(status, dialog);
    if (prompt !== undefined) return prompt;
  }
  return undefined;
}

const recognizers: readonly Recognizer[] = [claudeRecognizer, codexRecognizer];
