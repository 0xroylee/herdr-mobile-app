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
