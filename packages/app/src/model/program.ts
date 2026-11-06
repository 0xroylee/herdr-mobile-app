import type { Terminal } from "@herdr-mobile/protocol";

export type ProgramIconKey = "claude" | "codex" | "bot";

export interface ProgramInfo {
  name: string;
  iconKey: ProgramIconKey;
}

type JavaScriptRuntime = "node" | "bun" | "deno";

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
  if (isJavaScriptRuntime(normalized)) {
    const scriptProgram = programFromRuntimeArgv(terminal.foreground?.argv ?? [], normalized);
    if (scriptProgram !== undefined) return scriptProgram;
  }
  if (normalized === "claude") return { name: "Claude Code", iconKey: "claude" };
  if (normalized === "codex") return { name: "Codex", iconKey: "codex" };
  return { name: displayName(candidate), iconKey: "bot" };
}

function isJavaScriptRuntime(value: string): value is JavaScriptRuntime {
  return value === "node" || value === "bun" || value === "deno";
}

function programFromRuntimeArgv(
  argv: readonly string[],
  runtime: JavaScriptRuntime,
): ProgramInfo | undefined {
  if (argv[0] === undefined || normalizeProgram(argv[0]) !== runtime) return undefined;
  const scriptIndex = runtime !== "node" && argv[1] === "run" ? 2 : 1;
  const script = argv[scriptIndex];
  if (script === undefined || script.startsWith("-")) return undefined;
  return programFromEntryScript(script);
}

function programFromEntryScript(script: string | undefined): ProgramInfo | undefined {
  if (script === undefined) return undefined;
  const path = script.replace(/\\/g, "/").toLowerCase();
  const normalized = basename(path).replace(/\.(js|mjs|cjs)$/i, "");

  if (normalized === "claude" || /(?:^|\/)@anthropic-ai\/claude-code(?:\/|$)/.test(path)) {
    return { name: "Claude Code", iconKey: "claude" };
  }
  if (normalized === "codex" || /(?:^|\/)@openai\/codex(?:\/|$)/.test(path)) {
    return { name: "Codex", iconKey: "codex" };
  }
  return undefined;
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
