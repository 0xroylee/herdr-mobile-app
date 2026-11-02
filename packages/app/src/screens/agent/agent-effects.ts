import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { ConnectionManager } from "../../net/connection.ts";
// Extensionless so Metro selects Confirm.web.ts on web.
import { confirm } from "../../ui/components/Confirm";
import type { ConfirmOptions } from "../../ui/components/Confirm.ts";
import type { AttachmentView } from "./useAttachment.ts";

/**
 * Hides bridge calls and device effects behind one screen port. createAgentActionPort adapts the
 * real bridge, clipboard, confirm and haptic effects; action tests use fake implementations.
 */
export interface AgentActionPort {
  confirm(options: ConfirmOptions): Promise<boolean>;
  haptic(): Promise<unknown> | unknown;
  copy(value: string): Promise<void>;
  sendText(address: string, text: string, force: boolean): Promise<unknown>;
  sendKeys(address: string, keys: readonly string[]): Promise<unknown>;
  kill(address: string): Promise<unknown>;
  takeOver(cols: number, rows: number): Promise<void>;
}

export function createAgentActionPort(
  manager: ConnectionManager | undefined,
  attachment: Pick<AttachmentView, "takeOver">,
): AgentActionPort {
  const requireManager = () => {
    if (!manager) throw new Error("Not connected");
    return manager;
  };

  return {
    confirm,
    haptic: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    copy: async (value) => {
      await Clipboard.setStringAsync(value);
    },
    sendText: (address, text, force) =>
      requireManager().call("terminal.send", {
        terminal: address,
        text,
        ...(force ? { force: true } : {}),
      }),
    sendKeys: (address, keys) =>
      requireManager().call("terminal.keys", { terminal: address, keys: [...keys] }),
    kill: (address) => requireManager().call("terminal.kill", { terminal: address }),
    takeOver: (cols, rows) => attachment.takeOver(cols, rows),
  };
}
