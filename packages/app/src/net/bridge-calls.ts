import type {
  AgentCatalog,
  DeviceRecordView,
  StartAgentReply,
  StartAgentRequest,
} from "@herdr-mobile/protocol";
import type { Machine } from "../store/machines.ts";
import type { Secrets } from "../store/secrets.ts";
import { type BridgeApi, BridgeApiError, createBridgeApi } from "./bridge-api.ts";
import type { ConnectionManager } from "./connection.ts";

export interface BridgeCalls {
  health(): Promise<unknown>;
  devices(): Promise<DeviceRecordView[]>;
  revoke(id: string): Promise<void>;
  appLs(): Promise<unknown>;
  appDo(action: "space.new" | "tab.new", args?: Record<string, unknown>): Promise<unknown>;
  agentCatalog(): Promise<AgentCatalog>;
  startAgent(request: StartAgentRequest): Promise<StartAgentReply>;
}

export function bindBridgeCalls(api: BridgeApi, baseUrl: string, token: string): BridgeCalls {
  return {
    health: () => api.health(baseUrl, token),
    devices: () => api.devices(baseUrl, token),
    revoke: (id) => api.revoke(baseUrl, token, id),
    appLs: () => api.appLs(baseUrl, token),
    appDo: (action, args) => api.appDo(baseUrl, token, action, args),
    agentCatalog: () => api.agentCatalog(baseUrl, token),
    startAgent: (request) => api.startAgent(baseUrl, token, request),
  };
}

export function unavailableBridgeCalls(message: string): BridgeCalls {
  const fail = () => Promise.reject(new BridgeApiError(503, "not_connected", message));
  return {
    health: fail,
    devices: fail,
    revoke: fail,
    appLs: fail,
    appDo: fail,
    agentCatalog: fail,
    startAgent: fail,
  };
}

/** Resolve a machine's direct HTTP calls lazily, or delegate to its live connection. */
export function bridgeCallsFor(
  machine: Machine,
  secrets: Pick<Secrets, "get">,
  manager?: Pick<ConnectionManager, "calls">,
): BridgeCalls {
  if (manager) return manager.calls();
  if (!machine.routes.direct) {
    return unavailableBridgeCalls(`Not connected to ${machine.name}.`);
  }

  let bound: Promise<BridgeCalls> | undefined;
  const resolve = () => {
    bound ??= secrets.get(machine.id).then((token) => {
      if (!token) {
        throw new BridgeApiError(
          503,
          "token_unavailable",
          `The access token for ${machine.name} is unavailable.`,
        );
      }
      return bindBridgeCalls(
        createBridgeApi((input, init) => globalThis.fetch(input, init)),
        machine.routes.direct as string,
        token,
      );
    });
    return bound;
  };
  return lazyCalls(resolve);
}

export function lazyCalls(resolve: () => Promise<BridgeCalls>): BridgeCalls {
  return {
    health: () => resolve().then((calls) => calls.health()),
    devices: () => resolve().then((calls) => calls.devices()),
    revoke: (id) => resolve().then((calls) => calls.revoke(id)),
    appLs: () => resolve().then((calls) => calls.appLs()),
    appDo: (action, args) => resolve().then((calls) => calls.appDo(action, args)),
    agentCatalog: () => resolve().then((calls) => calls.agentCatalog()),
    startAgent: (request) => resolve().then((calls) => calls.startAgent(request)),
  };
}
