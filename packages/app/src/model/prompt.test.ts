/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  claudeCodeApprovalPrompt,
  claudeFortyRowQuestionPrompt,
  claudeSideBorderContextPrompt,
  claudeThirteenRowQuestionPrompt,
  claudeTitledBorderQuestionPrompt,
  claudeTwelveDiffRowsPrompt,
  claudeUnboxedPreparingChangePrompt,
  codexCommandApprovalPrompt,
  codexCommandApprovalPromptWithMsg,
  codexRepeatedMenuPrompt,
  codexRepeatedMenuTenWrappedRowsPrompt,
  codexRepeatedMenuWrappedPreviousChoicePrompt,
  codexThirteenRowQuestionPrompt,
  codexTitledBorderQuestionPrompt,
  codexTitledBorderStatementPrompt,
  mockupClaudePrompt,
  mockupClaudePromptWithMsg,
} from "./prompt/fixtures.ts";
import { recognizePrompt } from "./prompt.ts";

describe("recognizePrompt", () => {
  test("uses each program's status msg while preserving screen choices and Claude detail", () => {
    const claudeWithoutMsg = recognizePrompt(mockupClaudePrompt.status, mockupClaudePrompt.screen);
    if (claudeWithoutMsg === undefined)
      throw new Error("Expected the Claude fixture to be recognized");
    expect(
      recognizePrompt(mockupClaudePromptWithMsg.status, mockupClaudePromptWithMsg.screen),
    ).toEqual({
      question: "May I edit nav.md?",
      detail: claudeWithoutMsg?.detail,
      choices: claudeWithoutMsg?.choices,
    });

    const codexWithoutMsg = recognizePrompt(
      codexCommandApprovalPrompt.status,
      codexCommandApprovalPrompt.screen,
    );
    if (codexWithoutMsg === undefined)
      throw new Error("Expected the Codex fixture to be recognized");
    expect(
      recognizePrompt(
        codexCommandApprovalPromptWithMsg.status,
        codexCommandApprovalPromptWithMsg.screen,
      ),
    ).toEqual({
      question: "May I run the requested command?",
      choices: codexWithoutMsg?.choices,
    });
  });

  test("prefers and sanitizes msg, treats whitespace as absent, and caps it at 300 characters", () => {
    const screen = claudeCodeApprovalPrompt.screen;
    const status = claudeCodeApprovalPrompt.status;
    const noMsg = recognizePrompt(status, screen);
    if (noMsg === undefined) throw new Error("Expected the Claude fixture to be recognized");
    const differentMsg = recognizePrompt({ ...status, msg: "May I update config.ts?" }, screen);
    expect(differentMsg).toEqual({
      question: "May I update config.ts?",
      detail: noMsg?.detail,
      choices: noMsg?.choices,
    });

    expect(recognizePrompt({ ...status, msg: " \t\n " }, screen)).toEqual(noMsg);

    const longPrompt = recognizePrompt({ ...status, msg: "x".repeat(2048) }, screen);
    expect(longPrompt?.question.length).toBeLessThanOrEqual(300);
    expect(longPrompt?.question).toHaveLength(300);
    expect(longPrompt?.question.endsWith("…")).toBe(true);
    expect(longPrompt?.choices).toEqual(noMsg?.choices);
    expect(longPrompt?.detail).toBe(noMsg?.detail);

    expect(
      recognizePrompt({ ...status, msg: "  May I\u0001 edit\nnav.md?  " }, screen)?.question,
    ).toBe("May I edit nav.md?");
  });

  test("uses the final Codex menu across repeated menus and wrapped earlier choices", () => {
    const expected = {
      question: "Would you like to run the following command?",
      choices: [
        { label: "Yes, proceed", keys: ["up", "up", "enter"] },
        { label: "Yes, and don't ask again for bun test commands", keys: ["up", "enter"] },
        { label: "No, and tell Codex what to do differently", keys: ["enter"] },
      ],
    };
    for (const fixture of [
      codexRepeatedMenuPrompt,
      codexRepeatedMenuWrappedPreviousChoicePrompt,
      codexRepeatedMenuTenWrappedRowsPrompt,
    ]) {
      expect(recognizePrompt(fixture.status, fixture.screen)).toEqual(expected);
    }

    const withMsg = recognizePrompt(
      { ...codexRepeatedMenuPrompt.status, msg: "Status says this is a command check." },
      codexRepeatedMenuPrompt.screen,
    );
    expect(withMsg).toEqual({ ...expected, question: "Status says this is a command check." });
  });

  test("rejects unsupported numbered rows between choices for Claude and Codex, with and without msg", () => {
    const screen = [
      "Would you like to run this command?",
      "› 1. Yes",
      "     9007199254740992. unsupported numbered row",
      "  2. No",
    ];
    const statuses = [
      { state: "blocked", kind: "permission", app: "Claude Code" },
      {
        state: "blocked",
        kind: "permission",
        app: "Claude Code",
        msg: "May I run this command?",
      },
      { state: "blocked", kind: "permission", app: "Codex" },
      {
        state: "blocked",
        kind: "permission",
        app: "Codex",
        msg: "May I run this command?",
      },
    ] as const;

    for (const status of statuses) {
      expect(recognizePrompt(status, screen)).toBeUndefined();
    }
  });

  test("stops choice labels at unsupported numbered rows after the menu for Claude and Codex, with and without msg", () => {
    const screen = [
      "Would you like to run this command?",
      "› 1. Yes",
      "  2. No",
      "     9007199254740992. unsupported numbered row",
    ];
    const statuses = [
      { state: "blocked", kind: "permission", app: "Claude Code" },
      {
        state: "blocked",
        kind: "permission",
        app: "Claude Code",
        msg: "May I run this command?",
      },
      { state: "blocked", kind: "permission", app: "Codex" },
      {
        state: "blocked",
        kind: "permission",
        app: "Codex",
        msg: "May I run this command?",
      },
    ] as const;

    for (const status of statuses) {
      expect(recognizePrompt(status, screen)?.choices).toEqual([
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ]);
    }
  });

  test("walks complete long Claude and Codex questions, then uses neutral text over the cap", () => {
    const claudeQuestion = [
      "May I approve this",
      "change after",
      "reviewing the current",
      "workspace files and",
      "preserving existing",
      "settings while avoiding",
      "unrelated changes to",
      "the project before",
      "writing the selected",
      "content into the",
      "workspace and reporting",
      "the changed files",
      "when the work is done?",
    ].join(" ");
    expect(
      recognizePrompt(
        claudeThirteenRowQuestionPrompt.status,
        claudeThirteenRowQuestionPrompt.screen,
      ),
    ).toEqual({
      question: claudeQuestion,
      detail: "src/current.ts · +1 −1",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ],
    });

    const overlong = recognizePrompt(
      claudeFortyRowQuestionPrompt.status,
      claudeFortyRowQuestionPrompt.screen,
    );
    expect(overlong).toEqual({
      question: "Claude Code is asking for permission",
      detail: "src/current.ts · +1 −1",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ],
    });

    const codexQuestion = [
      "The command",
      "may change files",
      "inside this workspace",
      "as part of the",
      "current task and",
      "its validation steps",
      "while preserving",
      "the existing settings",
      "and local state",
      "so that you can",
      "review the request",
      "before deciding",
      "whether to proceed?",
    ].join(" ");
    expect(
      recognizePrompt(codexThirteenRowQuestionPrompt.status, codexThirteenRowQuestionPrompt.screen),
    ).toEqual({
      question: codexQuestion,
      choices: [
        { label: "Run", keys: ["enter"] },
        { label: "Cancel", keys: ["down", "enter"] },
      ],
    });
  });

  test("treats titled borders as boundaries and accepts Codex approval statements", () => {
    expect(
      recognizePrompt(
        claudeTitledBorderQuestionPrompt.status,
        claudeTitledBorderQuestionPrompt.screen,
      ),
    ).toEqual({
      question: "Do you want to allow this edit?",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(
        codexTitledBorderQuestionPrompt.status,
        codexTitledBorderQuestionPrompt.screen,
      ),
    ).toEqual({
      question: "Would you like to run this command?",
      choices: [
        { label: "Run", keys: ["enter"] },
        { label: "Cancel", keys: ["down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(
        codexTitledBorderStatementPrompt.status,
        codexTitledBorderStatementPrompt.screen,
      ),
    ).toEqual({
      question: "Approval required",
      choices: [
        { label: "Run", keys: ["enter"] },
        { label: "Cancel", keys: ["down", "enter"] },
      ],
    });
  });

  test("keeps file detail bound to context rows before the question", () => {
    expect(
      recognizePrompt(
        claudeUnboxedPreparingChangePrompt.status,
        claudeUnboxedPreparingChangePrompt.screen,
      ),
    ).toEqual({
      question: "Do you want to allow this edit?",
      detail: "src/current.ts · +1 −1",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(claudeTwelveDiffRowsPrompt.status, claudeTwelveDiffRowsPrompt.screen)?.detail,
    ).toBe("src/current.ts · +12 −0");
    expect(
      recognizePrompt(claudeSideBorderContextPrompt.status, claudeSideBorderContextPrompt.screen),
    ).toEqual({
      question: "Do you want to allow this edit?",
      detail: "src/current.ts · +1 −1",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "No", keys: ["down", "enter"] },
      ],
    });
  });

  test("uses a neutral line for a valid menu without a clean question", () => {
    const noticeScreen = [
      "╭─────────────╮",
      "│ A notice    │",
      "│ ❯ 1. Okay   │",
      "│   2. Close  │",
      "╰─────────────╯",
    ];
    const choices = [
      { label: "Okay", keys: ["enter"] },
      { label: "Close", keys: ["down", "enter"] },
    ];

    expect(
      recognizePrompt({ state: "blocked", kind: "permission", app: "Claude Code" }, noticeScreen),
    ).toEqual({
      question: "Claude Code is asking for permission",
      choices,
    });
    expect(
      recognizePrompt({ state: "blocked", kind: "question", app: "Claude Code" }, noticeScreen),
    ).toEqual({
      question: "Claude Code is asking a question",
      choices,
    });
    expect(
      recognizePrompt({ state: "blocked", kind: "auth", app: "Claude Code" }, noticeScreen),
    ).toEqual({
      question: "Claude Code is asking you to sign in",
      choices,
    });
    expect(recognizePrompt({ state: "blocked", app: "Claude Code" }, noticeScreen)).toEqual({
      question: "Claude Code is waiting for your answer",
      choices,
    });
    expect(
      recognizePrompt({ state: "blocked", kind: "permission", app: "Codex" }, noticeScreen),
    ).toEqual({
      question: "Codex is asking for permission",
      choices,
    });
  });

  test("preserves the existing mockup prompts, labels, keys, footer and detail rules", () => {
    expect(recognizePrompt(mockupClaudePrompt.status, mockupClaudePrompt.screen)).toEqual({
      question: "Do you want to make this edit to nav.md?",
      detail: "docs/nav.md · +3 −0",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "Yes, and don't ask again this session", keys: ["down", "enter"] },
        { label: "No, and tell Claude what to do", keys: ["down", "down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(claudeCodeApprovalPrompt.status, claudeCodeApprovalPrompt.screen),
    ).toEqual({
      question: "Do you want to make this edit to config.ts?",
      detail: "src/config.ts · +1 −1",
      choices: [
        { label: "Yes", keys: ["up", "enter"] },
        { label: "Yes, and don't ask again this session", keys: ["enter"] },
        { label: "No, and tell Claude what to do", keys: ["down", "enter"] },
      ],
    });
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

    const footer = "Press enter to confirm or esc to cancel";
    for (const fixture of [
      mockupClaudePrompt,
      claudeCodeApprovalPrompt,
      codexCommandApprovalPrompt,
    ]) {
      const prompt = recognizePrompt(fixture.status, [...fixture.screen, "", footer]);
      expect(prompt?.choices.at(-1)?.label).toBe(
        fixture === codexCommandApprovalPrompt
          ? "No, and tell Codex what to do differently"
          : "No, and tell Claude what to do",
      );
    }

    const fourRowWrap = [
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
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, fourRowWrap)?.choices).toEqual([
      {
        label:
          "Allow the command to read the configuration and the current working tree before it runs the selected checks and then keep the results available for inspection after the command returns to the terminal",
        keys: ["up", "enter"],
      },
      { label: "Yes, allow this command once", keys: ["enter"] },
      { label: "No", keys: ["down", "enter"] },
    ]);

    const oneTimeAndSession = [
      "╭──────────────────────────────────────────────────────╮",
      "│ Do you want to make this edit to config.ts?          │",
      "│ ❯ 1. Yes, allow once                                 │",
      "│   2. Yes, allow all edits during this session        │",
      "╰──────────────────────────────────────────────────────╯",
    ];
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, oneTimeAndSession)?.choices).toEqual([
      { label: "Yes, allow once", keys: ["enter"] },
      { label: "Yes, allow all edits during this session", keys: ["down", "enter"] },
    ]);

    const nearestHeader = [
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
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, nearestHeader)?.detail).toBe(
      "src/current.ts · +1 −1",
    );
    const noHeader = [
      "src/previous.ts",
      "+ previous line",
      "╭──────────────────────────────────────────────╮",
      "│ Do you want to make this edit to current.ts? │",
      "│ ❯ 1. Yes                                     │",
      "│   2. No                                      │",
      "╰──────────────────────────────────────────────╯",
    ];
    expect(recognizePrompt(claudeCodeApprovalPrompt.status, noHeader)?.detail).toBeUndefined();
  });

  test("rejects ambiguous menus, unknown programs and non-blocked status even when msg exists", () => {
    const validStatus = claudeCodeApprovalPrompt.status;
    const skippedNumber = [
      "╭─────────────────────────────╮",
      "│ Do you want to allow this?  │",
      "│ ❯ 1. Yes                    │",
      "│ 3. No                       │",
      "╰─────────────────────────────╯",
    ];
    const multipleSelected = [
      "╭─────────────────────────────╮",
      "│ Do you want to allow this?  │",
      "│ ❯ 1. Yes                    │",
      "│ ❯ 2. No                     │",
      "╰─────────────────────────────╯",
    ];
    const noSelection = [
      "╭─────────────────────────────╮",
      "│ Do you want to allow this?  │",
      "│   1. Yes                    │",
      "│   2. No                     │",
      "╰─────────────────────────────╯",
    ];
    const singleChoice = ["Do you want to allow this?", "❯ 1. Yes"];
    const noMenu = ["May I edit this file?"];

    for (const screen of [skippedNumber, multipleSelected, noSelection, singleChoice, noMenu]) {
      expect(recognizePrompt(validStatus, screen)).toBeUndefined();
    }
    expect(
      recognizePrompt({ ...validStatus, msg: "May I edit this file?" }, noMenu),
    ).toBeUndefined();
    expect(
      recognizePrompt({ state: "blocked", app: "other" }, mockupClaudePrompt.screen),
    ).toBeUndefined();
    expect(
      recognizePrompt({ state: "working", app: "Claude Code" }, mockupClaudePrompt.screen),
    ).toBeUndefined();
  });
});
