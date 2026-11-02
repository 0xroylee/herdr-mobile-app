import type { TerminalFit } from "../../terminal/zoom.ts";
import type { AgentActionPort } from "./agent-effects.ts";

export type { AgentActionPort } from "./agent-effects.ts";

export const KEY_BAR_KEYS = [
  { label: "esc", key: "esc" },
  { label: "⌃C", key: "ctrl+c" },
  { label: "tab", key: "tab" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "←", key: "left" },
  { label: "→", key: "right" },
  { label: "⏎", key: "enter" },
] as const;

export async function sendMessage(
  port: AgentActionPort,
  address: string,
  text: string,
  blocked: boolean,
): Promise<boolean> {
  if (text.trim().length === 0) return false;
  await port.haptic();
  await port.sendText(address, text, blocked);
  return true;
}

export async function sendKeys(
  port: AgentActionPort,
  address: string,
  keys: readonly string[],
): Promise<void> {
  await port.haptic();
  await port.sendKeys(address, keys);
}

export async function takeOver(
  port: AgentActionPort,
  readFit: () => TerminalFit | undefined,
): Promise<boolean> {
  const confirmed = await port.confirm({
    title: "Take over terminal?",
    message: "The Mac's terminal will resize to fit this screen.",
    confirmLabel: "Take over",
  });
  if (!confirmed) return false;
  const fit = readFit();
  if (!fit || fit.cols < 1 || fit.rows < 1) {
    throw new Error("The terminal pane has no size yet");
  }
  await port.takeOver(fit.cols, fit.rows);
  return true;
}

export async function interruptAgent(port: AgentActionPort, address: string): Promise<boolean> {
  const confirmed = await port.confirm({
    title: "Interrupt agent?",
    message: "Send Ctrl-C to this terminal.",
    confirmLabel: "Interrupt",
  });
  if (!confirmed) return false;
  await sendKeys(port, address, ["ctrl+c"]);
  return true;
}

export async function copyAddress(port: AgentActionPort, address: string): Promise<void> {
  await port.copy(address);
  await port.haptic();
}

export async function endTerminal(port: AgentActionPort, address: string): Promise<boolean> {
  const confirmed = await port.confirm({
    title: "End terminal?",
    message: "This ends the program running in the terminal.",
    confirmLabel: "End terminal",
  });
  if (!confirmed) return false;
  await port.kill(address);
  return true;
}
