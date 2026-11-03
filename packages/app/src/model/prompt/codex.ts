import type { Status } from "@herdr-mobile/protocol";
import type { Prompt, Recognizer } from "../prompt.ts";
import { type Dialog, keysForChoice } from "./dialog.ts";

export const codexRecognizer: Recognizer = {
  recognize(status, dialog) {
    return recognizeCodexPrompt(status, dialog);
  },
};

export function recognizeCodexPrompt(status: Status, dialog: Dialog): Prompt | undefined {
  if (status.state !== "blocked" || !/codex/i.test(status.app ?? "")) return undefined;
  const question =
    dialog.question ??
    (dialog.statement !== undefined &&
    /\b(?:approval|required|permission|allow|run|execute)\b/i.test(dialog.statement)
      ? dialog.statement
      : undefined);
  if (
    question === undefined ||
    !/\b(?:command|run|execute|approval|permission|allow|network)\b/i.test(question)
  ) {
    return undefined;
  }

  return {
    question,
    choices: dialog.menu.choices.map(({ label }, index) => ({
      label,
      keys: keysForChoice(dialog.menu.selectedIndex, index),
    })),
  };
}
