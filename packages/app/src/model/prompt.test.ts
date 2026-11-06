/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  blockedWithoutApp,
  claudeCodeApprovalPrompt,
  claudeFortyRowQuestionPrompt,
  claudeSideBorderContextPrompt,
  claudeThirteenRowQuestionPrompt,
  claudeTitledBorderQuestionPrompt,
  claudeTwelveDiffRowsPrompt,
  claudeUnboxedPreparingChangePrompt,
  codexCommandApprovalPrompt,
  codexCommandApprovalPromptWithMsg,
  codexMenuWithoutStatus,
  codexRepeatedMenuPrompt,
  codexRepeatedMenuTenWrappedRowsPrompt,
  codexRepeatedMenuWrappedPreviousChoicePrompt,
  codexThirteenRowQuestionPrompt,
  codexTitledBorderQuestionPrompt,
  codexTitledBorderStatementPrompt,
  menuWithoutStatus,
  mockupClaudePrompt,
  mockupClaudePromptWithMsg,
} from "./prompt/fixtures.ts";
import { promptKey, recognizePrompt } from "./prompt.ts";

describe("recognizePrompt", () => {
  test("uses each program's status msg while preserving screen choices and Claude detail", () => {
    const claudeWithoutMsg = recognizePrompt(
      mockupClaudePrompt.status,
      mockupClaudePrompt.screen,
      "Claude Code",
    );
    if (claudeWithoutMsg === undefined)
      throw new Error("Expected the Claude fixture to be recognized");
    expect(
      recognizePrompt(
        mockupClaudePromptWithMsg.status,
        mockupClaudePromptWithMsg.screen,
        "Claude Code",
      ),
    ).toEqual({
      question: "May I edit nav.md?",
      detail: claudeWithoutMsg?.detail,
      choices: claudeWithoutMsg?.choices,
    });

    const codexWithoutMsg = recognizePrompt(
      codexCommandApprovalPrompt.status,
      codexCommandApprovalPrompt.screen,
      "Codex",
    );
    if (codexWithoutMsg === undefined)
      throw new Error("Expected the Codex fixture to be recognized");
    expect(
      recognizePrompt(
        codexCommandApprovalPromptWithMsg.status,
        codexCommandApprovalPromptWithMsg.screen,
        "Codex",
      ),
    ).toEqual({
      question: "May I run the requested command?",
      choices: codexWithoutMsg?.choices,
    });
  });

  test("recognizes Claude and Codex menus without status and uses a neutral notice question", () => {
    expect(
      recognizePrompt(menuWithoutStatus.status, menuWithoutStatus.screen, "Claude Code"),
    ).toEqual({
      question: "Do you want to make this edit to nav.md?",
      detail: "docs/nav.md · +3 −0",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "Yes, and don't ask again this session", keys: ["down", "enter"] },
        { label: "No, and tell Claude what to do", keys: ["down", "down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(codexMenuWithoutStatus.status, codexMenuWithoutStatus.screen, "Codex"),
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

    expect(
      recognizePrompt(
        undefined,
        [
          "╭─────────────╮",
          "│ A notice    │",
          "│ ❯ 1. Okay   │",
          "│   2. Close  │",
          "╰─────────────╯",
        ],
        "Claude Code",
      ),
    ).toEqual({
      question: "Claude Code is waiting for your answer",
      choices: [
        { label: "Okay", keys: ["enter"] },
        { label: "Close", keys: ["down", "enter"] },
      ],
    });
  });

  test("uses a blocked message when the status has no app", () => {
    expect(
      recognizePrompt(
        { ...blockedWithoutApp.status, msg: "May I run it?" },
        blockedWithoutApp.screen,
        "Codex",
      ),
    ).toEqual({
      question: "May I run it?",
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

  test("suppresses only working status and keeps menu choices stable across status states", () => {
    const statuses = [
      undefined,
      null,
      { state: "blocked", kind: "permission", app: "Claude Code" },
      { state: "idle" },
      { state: "done" },
      { state: "error" },
    ] as const;
    const prompts = statuses.map((status) =>
      recognizePrompt(status, mockupClaudePrompt.screen, "Claude Code"),
    );
    const choices = prompts[0]?.choices;
    expect(choices).toBeDefined();
    for (const prompt of prompts) expect(prompt?.choices).toEqual(choices);
    for (const program of ["Bash", "Terminal"]) {
      for (const status of [mockupClaudePrompt.status, undefined]) {
        expect(recognizePrompt(status, mockupClaudePrompt.screen, program)).toBeUndefined();
      }
    }
    expect(
      recognizePrompt({ state: "working" }, mockupClaudePrompt.screen, "Claude Code"),
    ).toBeUndefined();
  });

  test("builds a menu identity from its question and labels, not its highlighted row", () => {
    const firstRowSelected = {
      question: "Choose one",
      choices: [
        { label: "Allow", keys: ["enter"] },
        { label: "Ask every time", keys: ["down", "enter"] },
        { label: "Skip", keys: ["down", "down", "enter"] },
      ],
    };
    const lastRowSelected = {
      question: "Choose one",
      choices: [
        { label: "Allow", keys: ["up", "up", "enter"] },
        { label: "Ask every time", keys: ["up", "enter"] },
        { label: "Skip", keys: ["enter"] },
      ],
    };
    expect(promptKey(firstRowSelected)).toBe(promptKey(lastRowSelected));
    expect(promptKey({ ...lastRowSelected, question: "Choose another" })).not.toBe(
      promptKey(lastRowSelected),
    );
    expect(
      promptKey({
        ...lastRowSelected,
        choices: lastRowSelected.choices.map((choice, index) =>
          index === 1 ? { ...choice, label: "Continue" } : choice,
        ),
      }),
    ).not.toBe(promptKey(lastRowSelected));
  });

  test("prefers and sanitizes msg, treats whitespace as absent, and caps it at 300 characters", () => {
    const screen = claudeCodeApprovalPrompt.screen;
    const status = claudeCodeApprovalPrompt.status;
    const noMsg = recognizePrompt(
      status,
      screen,
      status.app?.toLowerCase().includes("codex") ? "Codex" : "Claude Code",
    );
    if (noMsg === undefined) throw new Error("Expected the Claude fixture to be recognized");
    const differentMsg = recognizePrompt(
      { ...status, msg: "May I update config.ts?" },
      screen,
      "Claude Code",
    );
    expect(differentMsg).toEqual({
      question: "May I update config.ts?",
      detail: noMsg?.detail,
      choices: noMsg?.choices,
    });

    expect(recognizePrompt({ ...status, msg: " \t\n " }, screen, "Claude Code")).toEqual(noMsg);

    const longPrompt = recognizePrompt({ ...status, msg: "x".repeat(2048) }, screen, "Claude Code");
    expect(longPrompt?.question.length).toBeLessThanOrEqual(300);
    expect(longPrompt?.question).toHaveLength(300);
    expect(longPrompt?.question.endsWith("…")).toBe(true);
    expect(longPrompt?.choices).toEqual(noMsg?.choices);
    expect(longPrompt?.detail).toBe(noMsg?.detail);

    expect(
      recognizePrompt({ ...status, msg: "  May I\u0001 edit\nnav.md?  " }, screen, "Claude Code")
        ?.question,
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
      expect(
        recognizePrompt(
          fixture.status,
          fixture.screen,
          fixture.status.app?.toLowerCase().includes("codex") ? "Codex" : "Claude Code",
        ),
      ).toEqual(expected);
    }

    const withMsg = recognizePrompt(
      { ...codexRepeatedMenuPrompt.status, msg: "Status says this is a command check." },
      codexRepeatedMenuPrompt.screen,
      "Codex",
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
      expect(
        recognizePrompt(
          status,
          screen,
          status.app?.toLowerCase().includes("codex") ? "Codex" : "Claude Code",
        ),
      ).toBeUndefined();
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
      expect(
        recognizePrompt(
          status,
          screen,
          status.app?.toLowerCase().includes("codex") ? "Codex" : "Claude Code",
        )?.choices,
      ).toEqual([
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
        "Claude Code",
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
      "Claude Code",
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
      recognizePrompt(
        codexThirteenRowQuestionPrompt.status,
        codexThirteenRowQuestionPrompt.screen,
        "Codex",
      ),
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
        "Claude Code",
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
        "Codex",
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
        "Codex",
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
        "Claude Code",
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
      recognizePrompt(
        claudeTwelveDiffRowsPrompt.status,
        claudeTwelveDiffRowsPrompt.screen,
        "Claude Code",
      )?.detail,
    ).toBe("src/current.ts · +12 −0");
    expect(
      recognizePrompt(
        claudeSideBorderContextPrompt.status,
        claudeSideBorderContextPrompt.screen,
        "Claude Code",
      ),
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
      recognizePrompt(
        { state: "blocked", kind: "permission", app: "Claude Code" },
        noticeScreen,
        "Claude Code",
      ),
    ).toEqual({
      question: "Claude Code is asking for permission",
      choices,
    });
    expect(
      recognizePrompt(
        { state: "blocked", kind: "question", app: "Claude Code" },
        noticeScreen,
        "Claude Code",
      ),
    ).toEqual({
      question: "Claude Code is asking a question",
      choices,
    });
    expect(
      recognizePrompt(
        { state: "blocked", kind: "auth", app: "Claude Code" },
        noticeScreen,
        "Claude Code",
      ),
    ).toEqual({
      question: "Claude Code is asking you to sign in",
      choices,
    });
    expect(
      recognizePrompt({ state: "blocked", app: "Claude Code" }, noticeScreen, "Claude Code"),
    ).toEqual({
      question: "Claude Code is waiting for your answer",
      choices,
    });
    expect(
      recognizePrompt(
        { state: "blocked", kind: "permission", app: "Codex" },
        noticeScreen,
        "Codex",
      ),
    ).toEqual({
      question: "Codex is asking for permission",
      choices,
    });
    expect(
      recognizePrompt(
        { state: "idle", kind: "permission", app: "Claude Code" },
        noticeScreen,
        "Claude Code",
      ),
    ).toEqual({
      question: "Claude Code is waiting for your answer",
      choices,
    });
  });

  test("preserves the existing mockup prompts, labels, keys, footer and detail rules", () => {
    expect(
      recognizePrompt(mockupClaudePrompt.status, mockupClaudePrompt.screen, "Claude Code"),
    ).toEqual({
      question: "Do you want to make this edit to nav.md?",
      detail: "docs/nav.md · +3 −0",
      choices: [
        { label: "Yes", keys: ["enter"] },
        { label: "Yes, and don't ask again this session", keys: ["down", "enter"] },
        { label: "No, and tell Claude what to do", keys: ["down", "down", "enter"] },
      ],
    });
    expect(
      recognizePrompt(
        claudeCodeApprovalPrompt.status,
        claudeCodeApprovalPrompt.screen,
        "Claude Code",
      ),
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
      recognizePrompt(
        codexCommandApprovalPrompt.status,
        codexCommandApprovalPrompt.screen,
        "Codex",
      ),
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
      const prompt = recognizePrompt(
        fixture.status,
        [...fixture.screen, "", footer],
        fixture.status.app?.toLowerCase().includes("codex") ? "Codex" : "Claude Code",
      );
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
    expect(
      recognizePrompt(claudeCodeApprovalPrompt.status, fourRowWrap, "Claude Code")?.choices,
    ).toEqual([
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
    expect(
      recognizePrompt(claudeCodeApprovalPrompt.status, oneTimeAndSession, "Claude Code")?.choices,
    ).toEqual([
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
    expect(
      recognizePrompt(claudeCodeApprovalPrompt.status, nearestHeader, "Claude Code")?.detail,
    ).toBe("src/current.ts · +1 −1");
    const noHeader = [
      "src/previous.ts",
      "+ previous line",
      "╭──────────────────────────────────────────────╮",
      "│ Do you want to make this edit to current.ts? │",
      "│ ❯ 1. Yes                                     │",
      "│   2. No                                      │",
      "╰──────────────────────────────────────────────╯",
    ];
    expect(
      recognizePrompt(claudeCodeApprovalPrompt.status, noHeader, "Claude Code")?.detail,
    ).toBeUndefined();
  });

  test("rejects ambiguous menus and unknown programs with and without status", () => {
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
      for (const status of [validStatus, undefined]) {
        expect(recognizePrompt(status, screen, "Claude Code")).toBeUndefined();
      }
    }
    expect(
      recognizePrompt({ ...validStatus, msg: "May I edit this file?" }, noMenu, "Claude Code"),
    ).toBeUndefined();
    for (const program of ["Bash", "Terminal"]) {
      for (const status of [validStatus, undefined]) {
        expect(recognizePrompt(status, mockupClaudePrompt.screen, program)).toBeUndefined();
      }
    }
    expect(
      recognizePrompt(
        { state: "working", app: "Claude Code" },
        mockupClaudePrompt.screen,
        "Claude Code",
      ),
    ).toBeUndefined();
  });
});
