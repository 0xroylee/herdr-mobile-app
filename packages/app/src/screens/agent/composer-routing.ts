import { type Prompt, promptKey } from "../../model/prompt.ts";

export type ComposerRoute =
  | { kind: "answer"; keys: readonly string[] }
  | { kind: "send" }
  | { kind: "refuse"; notice: string };

const optionNotice = "Tap an option above, or type its number.";
const pendingAnswerNotice = "An answer for this menu is already being sent.";
const answeredMenuNotice = "This menu has already been answered.";

export interface PromptAnswerGuard {
  pendingPromptKey?: string;
  sentPromptKey?: string;
}

export function promptAnswerBlockNotice(
  key: string,
  guard: PromptAnswerGuard = {},
): string | undefined {
  if (guard.pendingPromptKey === key) return pendingAnswerNotice;
  if (guard.sentPromptKey === key) return answeredMenuNotice;
  return undefined;
}

/** Routes composer text without sending menu answers through terminal.send. */
export function routeComposerText(
  text: string,
  prompt: Prompt | undefined,
  offered: boolean,
  guard: PromptAnswerGuard = {},
): ComposerRoute {
  if (!offered || prompt === undefined) return { kind: "send" };

  const trimmed = text.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    const choiceIndex = Number(trimmed) - 1;
    if (Number.isSafeInteger(choiceIndex) && choiceIndex < prompt.choices.length) {
      const notice = promptAnswerBlockNotice(promptKey(prompt), guard);
      if (notice !== undefined) return { kind: "refuse", notice };
      return { kind: "answer", keys: prompt.choices[choiceIndex].keys };
    }
  }

  return { kind: "refuse", notice: optionNotice };
}
