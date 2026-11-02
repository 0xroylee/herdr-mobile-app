import type { Status } from "@herdr-mobile/protocol";
import {
  extractPromptQuestion,
  keysForChoice,
  type Prompt,
  parseNumberedChoiceBlock,
  type Recognizer,
} from "../prompt.ts";

export const codexRecognizer: Recognizer = {
  recognize(status, screen) {
    return recognizeCodexPrompt(status, screen);
  },
};

export function recognizeCodexPrompt(
  status: Status,
  screen: readonly string[],
): Prompt | undefined {
  if (status.state !== "blocked" || !/codex/i.test(status.app ?? "")) return undefined;
  const block = parseNumberedChoiceBlock(screen);
  if (block === undefined) return undefined;
  const question = extractPromptQuestion(screen, block.firstLine, true);
  if (
    question === undefined ||
    !/\b(?:command|run|execute|approval|permission|allow|network)\b/i.test(question)
  ) {
    return undefined;
  }

  const selectedIndex = block.choices.findIndex(({ selected }) => selected);
  if (selectedIndex < 0) return undefined;
  return {
    question,
    choices: block.choices.map(({ label }, index) => ({
      label,
      keys: keysForChoice(selectedIndex, index),
    })),
  };
}
