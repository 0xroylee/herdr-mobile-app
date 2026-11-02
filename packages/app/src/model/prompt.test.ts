/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  claudeCodeApprovalPrompt,
  codexCommandApprovalPrompt,
  mockupClaudePrompt,
} from "./prompt/fixtures.ts";
import { recognizePrompt } from "./prompt.ts";

describe("recognizePrompt", () => {
  test("recognizes the mockup Claude approval, detail and choices", () => {
    expect(recognizePrompt(mockupClaudePrompt.status, mockupClaudePrompt.screen)).toEqual({
      question: "Do you want to make this edit to nav.md?",
      detail: "docs/nav.md · +3 −0",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "Yes, and don't ask again this session", keys: ["down", "enter"] },
        { label: "No, and tell Claude what to do", keys: ["down", "down", "enter"] },
      ],
    });
  });

  test("maps Claude choices relative to the currently highlighted row", () => {
    const prompt = recognizePrompt(
      claudeCodeApprovalPrompt.status,
      claudeCodeApprovalPrompt.screen,
    );
    expect(prompt?.question).toBe("Do you want to make this edit to config.ts?");
    expect(prompt?.detail).toBe("src/config.ts · +1 −1");
    expect(prompt?.choices.map(({ keys }) => keys)).toEqual([
      ["up", "enter"],
      ["enter"],
      ["down", "enter"],
    ]);
  });

  test("recognizes the Codex command approval choices", () => {
    expect(
      recognizePrompt(codexCommandApprovalPrompt.status, codexCommandApprovalPrompt.screen),
    ).toEqual({
      question: "Would you like to run the following command?",
      choices: [
        { label: "Yes, proceed", keys: ["enter"] },
        { label: "Yes, and don't ask again for bun test commands", keys: ["down", "enter"] },
        {
          label: "No, and tell Codex what to do differently",
          keys: ["down", "down", "enter"],
        },
      ],
    });
  });

  test("recognizes only the last Codex approval list when two lists share the screen", () => {
    const screen = [
      "Would you like to run the following command?",
      "$ npm install",
      "  1. Yes, proceed",
      "› 2. Yes, and don't ask again for npm install",
      "  3. No, and tell Codex what to do differently",
      "Would you like to run the following command?",
      "$ bun test packages/app/src/model",
      "  1. Yes, proceed",
      "  2. Yes, and don't ask again for bun test commands",
      "› 3. No, and tell Codex what to do differently",
    ];

    const prompt = recognizePrompt(codexCommandApprovalPrompt.status, screen);
    expect(prompt?.choices).toEqual([
      { label: "Yes, proceed", keys: ["up", "up", "enter"] },
      { label: "Yes, and don't ask again for bun test commands", keys: ["up", "enter"] },
      { label: "No, and tell Codex what to do differently", keys: ["enter"] },
    ]);
  });

  test("does not append blank rows or footer text to existing approval labels", () => {
    const cases = [
      [mockupClaudePrompt, "No, and tell Claude what to do"],
      [claudeCodeApprovalPrompt, "No, and tell Claude what to do"],
      [codexCommandApprovalPrompt, "No, and tell Codex what to do differently"],
    ] as const;
    const footer = "Press enter to confirm or esc to cancel";

    for (const [fixture, expectedLastLabel] of cases) {
      const prompt = recognizePrompt(fixture.status, [...fixture.screen, "", footer]);
      expect(prompt?.choices.at(-1)?.label).toBe(expectedLastLabel);
    }
  });

  test("keeps a four-row wrapped choice in a boxed Claude approval menu", () => {
    const screen = [
      "╭─────────────────────────────────────────────────────────────╮",
      "│ Do you want to allow this command?                          │",
      "│ 1. Allow the command to read the configuration and the       │",
      "│    current working tree before it runs the selected checks  │",
      "│    and then keep the results available for inspection       │",
      "│    after the command returns to the terminal                │",
      "│ ❯ 2. Yes, allow this command once                            │",
      "│ 3. No                                                       │",
      "╰─────────────────────────────────────────────────────────────╯",
    ];
    const prompt = recognizePrompt(claudeCodeApprovalPrompt.status, screen);

    expect(prompt?.choices).toEqual([
      {
        label:
          "Allow the command to read the configuration and the current working tree before it runs the selected checks and then keep the results available for inspection after the command returns to the terminal",
        keys: ["up", "enter"],
      },
      { label: "Yes, allow this command once", keys: ["enter"] },
      { label: "No", keys: ["down", "enter"] },
    ]);
  });

  test("rejects skipped choice numbers", () => {
    const skippedNumber = [
      "╭─────────────────────────────╮",
      "│ Do you want to allow this?  │",
      "│ ❯ 1. Yes                    │",
      "│ 3. No                       │",
      "╰─────────────────────────────╯",
    ];

    expect(recognizePrompt(claudeCodeApprovalPrompt.status, skippedNumber)).toBeUndefined();
  });

  test("rejects a menu with multiple highlighted rows", () => {
    const multipleSelected = [
      "╭─────────────────────────────╮",
      "│ Do you want to allow this?  │",
      "│ ❯ 1. Yes                    │",
      "│ ❯ 2. No                     │",
      "╰─────────────────────────────╯",
    ];

    expect(recognizePrompt(claudeCodeApprovalPrompt.status, multipleSelected)).toBeUndefined();
  });

  test("keeps one-time and session-wide approval labels distinct with their own keys", () => {
    const screen = [
      "╭──────────────────────────────────────────────────────╮",
      "│ Do you want to make this edit to config.ts?          │",
      "│ ❯ 1. Yes, allow once                                 │",
      "│   2. Yes, allow all edits during this session        │",
      "╰──────────────────────────────────────────────────────╯",
    ];
    const prompt = recognizePrompt(claudeCodeApprovalPrompt.status, screen);
    expect(prompt?.choices).toEqual([
      { label: "Yes, allow once", keys: ["enter"] },
      { label: "Yes, allow all edits during this session", keys: ["down", "enter"] },
    ]);
  });

  test("binds file detail to the nearest edit header and its diff rows", () => {
    const screen = [
      "Read src/previous.ts",
      "+ previous line",
      "- older line",
      "Edit src/current.ts",
      "- const enabled = false;",
      "+ const enabled = true;",
      "╭──────────────────────────────────────────────╮",
      "│ Do you want to make this edit to current.ts? │",
      "│ ❯ 1. Yes                                     │",
      "│   2. No                                      │",
      "╰──────────────────────────────────────────────╯",
    ];
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, screen)?.detail).toBe(
      "src/current.ts · +1 −1",
    );
  });

  test("omits file detail when the dialog has no read, edit, or write header", () => {
    const screen = [
      "src/previous.ts",
      "+ previous line",
      "╭──────────────────────────────────────────────╮",
      "│ Do you want to make this edit to current.ts? │",
      "│ ❯ 1. Yes                                     │",
      "│   2. No                                      │",
      "╰──────────────────────────────────────────────╯",
    ];
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, screen)?.detail).toBeUndefined();
  });

  test("returns nothing for unknown screens, programs, or non-blocked status", () => {
    const unknownScreen = [
      "╭─────────────╮",
      "│ A notice    │",
      "│ ❯ 1. Okay   │",
      "│   2. Close  │",
      "╰─────────────╯",
    ];
    expect(recognizePrompt(mockupClaudePrompt.status, unknownScreen)).toBeUndefined();
    expect(
      recognizePrompt({ state: "blocked", app: "other" }, mockupClaudePrompt.screen),
    ).toBeUndefined();
    expect(
      recognizePrompt({ state: "working", app: "Claude Code" }, mockupClaudePrompt.screen),
    ).toBeUndefined();
  });
});
