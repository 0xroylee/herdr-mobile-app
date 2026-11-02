import type { Terminal } from "@herdr-mobile/protocol";

export type ProgramIconKey = "claude" | "codex" | "bot";

export interface ProgramInfo {
  name: string;
  iconKey: ProgramIconKey;
}

/** Choose a display name and the corresponding herdr-app icon key. */
export function getProgram(
  terminal: Pick<Terminal, "argv" | "foreground" | "status">,
): ProgramInfo {
  const reportedApp = terminal.status?.app?.trim();
  const foregroundName = terminal.foreground?.name?.trim();
  const foregroundArg = terminal.foreground?.argv[0];
  const terminalArg = terminal.argv[0];
  const candidate = reportedApp || foregroundName || foregroundArg || terminalArg || "Terminal";
  const normalized = normalizeProgram(candidate);
  if (normalized === "claude") return { name: "Claude Code", iconKey: "claude" };
  if (normalized === "codex") return { name: "Codex", iconKey: "codex" };
  return { name: displayName(candidate), iconKey: "bot" };
}

function normalizeProgram(value: string): string {
  const name = basename(value)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/i, "");
  if (
    name === "claude" ||
    name === "claude-code" ||
    name === "claude_code" ||
    name === "claude code"
  ) {
    return "claude";
  }
  if (name === "codex" || name === "openai-codex" || name === "openai codex") return "codex";
  return name;
}

function basename(value: string): string {
  const cleaned = value.trim().replace(/[\\/]+$/, "");
  return cleaned.slice(Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\")) + 1);
}

function displayName(value: string): string {
  const base = basename(value)
    .replace(/\.(exe|cmd|bat)$/i, "")
    .replace(/[-_]+/g, " ");
  const firstCharacter = base.charAt(0);
  return firstCharacter.length === 0 ? "Terminal" : firstCharacter.toUpperCase() + base.slice(1);
}
