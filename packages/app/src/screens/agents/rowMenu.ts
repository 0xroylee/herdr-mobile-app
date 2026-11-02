import type { Role } from "@herdr-mobile/protocol";
import type { ConnectionManager } from "../../net/connection.ts";

export type AgentRowActionId = "copy-address" | "take-over";

export interface AgentRowAction {
  id: AgentRowActionId;
  label: string;
}

/** Watch devices can copy an address but cannot take control of a terminal. */
export function agentRowActions(role: Role | undefined): AgentRowAction[] {
  const actions: AgentRowAction[] = [{ id: "copy-address", label: "Copy address" }];
  if (role === "control") actions.push({ id: "take-over", label: "Take over" });
  return actions;
}

/** Encode the address as one route segment, including remote `machine/terminal` addresses. */
export function agentRoute(address: string, takeover = false): string {
  const path = `/agent/${encodeURIComponent(address)}`;
  return takeover ? `${path}?takeover=1` : path;
}

export interface AgentRowActionHandlers {
  copyAddress(address: string): void | Promise<void>;
  takeOver(address: string): void;
}

/** Dispatch the selected menu action through screen-owned effects. */
export async function dispatchAgentRowAction(
  action: AgentRowActionId,
  address: string,
  handlers: AgentRowActionHandlers,
): Promise<void> {
  if (action === "copy-address") {
    await handlers.copyAddress(address);
    return;
  }
  handlers.takeOver(address);
}

/** Restart the current manager in the established stop-then-start order. */
export function retryConnection(
  manager: Pick<ConnectionManager, "stop" | "start"> | undefined,
): void {
  if (manager === undefined) return;
  manager.stop();
  manager.start();
}
