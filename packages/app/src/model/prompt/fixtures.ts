import type { Status } from "@herdr-mobile/protocol";

export interface PromptFixture {
  status: Status;
  screen: readonly string[];
}

// Adapted from screen 3's terminal pane in docs/ui/mockups.html; the file and diff context is shown above the approval box.
export const mockupClaudePrompt: PromptFixture = {
  status: { state: "blocked", kind: "permission", app: "Claude Code" },
  screen: [
    "Edit docs/nav.md",
    "  + - API",
    "  +   - Authentication",
    "  +   - Rate limits",
    "╭────────────────────────────────────────╮",
    "│ Do you want to make this edit to       │",
    "│ nav.md?                                │",
    "│ ❯ 1. Yes                               │",
    "│   2. Yes, and don't ask again this     │",
    "│      session                           │",
    "│   3. No, and tell Claude what to do    │",
    "╰────────────────────────────────────────╯",
  ],
};

export const menuWithoutStatus = {
  status: undefined,
  screen: mockupClaudePrompt.screen,
};

// Representative Claude Code file approval dialog from its terminal permission menu; capture on the first native run is still pending.
export const claudeCodeApprovalPrompt: PromptFixture = {
  status: { state: "blocked", kind: "permission", app: "claude" },
  screen: [
    "Edit src/config.ts",
    "  - const enabled = false;",
    "  + const enabled = true;",
    "╭──────────────────────────────────────────────╮",
    "│ Do you want to make this edit to config.ts?  │",
    "│   1. Yes                                     │",
    "│ ❯ 2. Yes, and don't ask again this session   │",
    "│   3. No, and tell Claude what to do          │",
    "╰──────────────────────────────────────────────╯",
  ],
};

// Representative Codex command approval menu; capture on the first native run is still pending.
export const codexCommandApprovalPrompt: PromptFixture = {
  status: { state: "blocked", kind: "permission", app: "Codex" },
  screen: [
    "Would you like to run the following command?",
    "$ bun test packages/app/src/model",
    "› 1. Yes, proceed",
    "  2. Yes, and don't ask again for bun test commands",
    "  3. No, and tell Codex what to do differently",
  ],
};

export const codexMenuWithoutStatus = {
  status: null,
  screen: codexCommandApprovalPrompt.screen,
};

export const blockedWithoutApp = {
  status: { state: "blocked", kind: "permission" },
  screen: codexCommandApprovalPrompt.screen,
} as const;

export const mockupClaudePromptWithMsg: PromptFixture = {
  status: { ...mockupClaudePrompt.status, msg: "May I edit nav.md?" },
  screen: mockupClaudePrompt.screen,
};

export const codexCommandApprovalPromptWithMsg: PromptFixture = {
  status: { ...codexCommandApprovalPrompt.status, msg: "May I run the requested command?" },
  screen: codexCommandApprovalPrompt.screen,
};

export const codexRepeatedMenuPrompt: PromptFixture = {
  status: codexCommandApprovalPrompt.status,
  screen: [
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
  ],
};

export const codexRepeatedMenuWrappedPreviousChoicePrompt: PromptFixture = {
  status: codexRepeatedMenuPrompt.status,
  screen: [
    "Would you like to run the following command?",
    "$ npm install",
    "  1. Yes, proceed",
    "› 2. Yes, and don't ask again for npm install",
    "  3. No, and tell Codex what to do",
    "     differently",
    "Would you like to run the following command?",
    "$ bun test packages/app/src/model",
    "  1. Yes, proceed",
    "  2. Yes, and don't ask again for bun test commands",
    "› 3. No, and tell Codex what to do differently",
  ],
};

export const codexRepeatedMenuTenWrappedRowsPrompt: PromptFixture = {
  status: codexRepeatedMenuPrompt.status,
  screen: [
    "Would you like to run the following command?",
    "$ npm install",
    "  1. Yes, proceed",
    "› 2. Yes, and don't ask again for npm install",
    "  3. No, and tell Codex what to do",
    "     differently on the current system",
    "     without changing other settings",
    "     while keeping the existing workspace",
    "     and preserving command history",
    "     after the command finishes",
    "     with the selected package manager",
    "     and the current environment values",
    "     so the result can be reviewed later",
    "     in the same terminal session",
    "     without repeating the request",
    "Would you like to run the following command?",
    "$ bun test packages/app/src/model",
    "  1. Yes, proceed",
    "  2. Yes, and don't ask again for bun test commands",
    "› 3. No, and tell Codex what to do differently",
  ],
};

export const claudeThirteenRowQuestionPrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "Edit src/current.ts",
    "- const enabled = false;",
    "+ const enabled = true;",
    "╭──────────────────────────────────────────────────────╮",
    "│ May I approve this",
    "│ change after",
    "│ reviewing the current",
    "│ workspace files and",
    "│ preserving existing",
    "│ settings while avoiding",
    "│ unrelated changes to",
    "│ the project before",
    "│ writing the selected",
    "│ content into the",
    "│ workspace and reporting",
    "│ the changed files",
    "│ when the work is done?",
    "│ ❯ 1. Yes",
    "│   2. No",
    "╰──────────────────────────────────────────────────────╯",
  ],
};

const longClaudeQuestionRows = Array.from({ length: 40 }, (_, index) =>
  index === 0
    ? "│ May I allow this change after checking the full project context"
    : `│ additional explanation segment ${index}${index === 39 ? "?" : ""}`,
);

export const claudeFortyRowQuestionPrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "Edit src/current.ts",
    "- const enabled = false;",
    "+ const enabled = true;",
    "╭──────────────────────────────────────────────────────╮",
    ...longClaudeQuestionRows,
    "│ ❯ 1. Yes",
    "│   2. No",
    "╰──────────────────────────────────────────────────────╯",
  ],
};

export const codexThirteenRowQuestionPrompt: PromptFixture = {
  status: codexCommandApprovalPrompt.status,
  screen: [
    "╭──────────────────────────────────────────────────────╮",
    "│ The command",
    "│ may change files",
    "│ inside this workspace",
    "│ as part of the",
    "│ current task and",
    "│ its validation steps",
    "│ while preserving",
    "│ the existing settings",
    "│ and local state",
    "│ so that you can",
    "│ review the request",
    "│ before deciding",
    "│ whether to proceed?",
    "│ ❯ 1. Run",
    "│   2. Cancel",
    "╰──────────────────────────────────────────────────────╯",
  ],
};

export const claudeTitledBorderQuestionPrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "╭ Approval required ─────────────────────────╮",
    "│ Do you want to allow this edit?            │",
    "│ ❯ 1. Yes                                   │",
    "│   2. No                                    │",
    "╰────────────────────────────────────────────╯",
  ],
};

export const codexTitledBorderQuestionPrompt: PromptFixture = {
  status: codexCommandApprovalPrompt.status,
  screen: [
    "╭ Approval required ─────────────────────────╮",
    "│ Would you like to run this command?        │",
    "│ ❯ 1. Run                                   │",
    "│   2. Cancel                                │",
    "╰────────────────────────────────────────────╯",
  ],
};

export const codexTitledBorderStatementPrompt: PromptFixture = {
  status: codexCommandApprovalPrompt.status,
  screen: [
    "╭ Approval required ─────────────────────────╮",
    "│ Approval required                          │",
    "│ ❯ 1. Run                                   │",
    "│   2. Cancel                                │",
    "╰────────────────────────────────────────────╯",
  ],
};

export const claudeUnboxedPreparingChangePrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "Preparing change",
    "Edit src/current.ts",
    "- const enabled = false;",
    "+ const enabled = true;",
    "Do you want to allow this edit?",
    "❯ 1. Yes",
    "  2. No",
  ],
};

export const claudeTwelveDiffRowsPrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "Edit src/current.ts",
    ...Array.from({ length: 12 }, (_, index) => `+ inserted line ${index + 1}`),
    "Do you want to allow this edit?",
    "❯ 1. Yes",
    "  2. No",
  ],
};

export const claudeSideBorderContextPrompt: PromptFixture = {
  status: claudeCodeApprovalPrompt.status,
  screen: [
    "│ Edit src/current.ts │",
    "│ - const enabled = false; │",
    "│ + const enabled = true; │",
    "Do you want to allow this edit?",
    "❯ 1. Yes",
    "  2. No",
  ],
};
