/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { type Prompt, promptKey } from "../../model/prompt.ts";
import { promptAnswerBlockNotice, routeComposerText } from "./composer-routing.ts";

const prompt: Prompt = {
  question: "Choose one",
  choices: [
    { label: "First", keys: ["up", "enter"] },
    { label: "Second", keys: ["enter"] },
    { label: "Third", keys: ["down", "enter"] },
  ],
};

describe("routeComposerText", () => {
  test("routes an in-range integer to the matching prompt choice", () => {
    expect(routeComposerText("2", prompt, true)).toEqual({
      kind: "answer",
      keys: ["enter"],
    });
    expect(routeComposerText(" 2 ", prompt, true)).toEqual({
      kind: "answer",
      keys: ["enter"],
    });
  });

  test("refuses text that is not one offered choice number", () => {
    for (const text of ["0", "4", "2 please", "yes", ""]) {
      expect(routeComposerText(text, prompt, true)).toEqual({
        kind: "refuse",
        notice: "Tap an option above, or type its number.",
      });
    }
  });

  test("keeps ordinary composer sends when no choices are offered", () => {
    expect(routeComposerText("2", undefined, true)).toEqual({ kind: "send" });
    expect(routeComposerText("yes", undefined, true)).toEqual({ kind: "send" });
    expect(routeComposerText("yes", prompt, false)).toEqual({ kind: "send" });
    expect(routeComposerText("2", prompt, false)).toEqual({ kind: "send" });
  });

  test("blocks only a pending or sent answer for the same prompt key", () => {
    const key = promptKey(prompt);
    const changedPrompt: Prompt = {
      question: "Choose another one",
      choices: prompt.choices,
    };

    expect(routeComposerText("2", prompt, true, { pendingPromptKey: key })).toEqual({
      kind: "refuse",
      notice: "An answer for this menu is already being sent.",
    });
    expect(routeComposerText("2", prompt, true, { sentPromptKey: key })).toEqual({
      kind: "refuse",
      notice: "This menu has already been answered.",
    });
    expect(
      promptAnswerBlockNotice(promptKey(changedPrompt), {
        pendingPromptKey: key,
        sentPromptKey: key,
      }),
    ).toBeUndefined();
    expect(routeComposerText("2", changedPrompt, true, { sentPromptKey: key })).toEqual({
      kind: "answer",
      keys: ["enter"],
    });
  });
});
