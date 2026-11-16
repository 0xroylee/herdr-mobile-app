import type {
  CheckTaskRequest,
  ClearTasksRequest,
  LinkTaskRequest,
  StartTaskReply,
  StartTaskRequest,
  UncheckTaskRequest,
} from "@herdr-mobile/protocol";
import type { ConfirmOptions } from "../ui/components/Confirm.ts";
import type { BridgeCalls } from "./bridge-calls.ts";
import type { ConnectionManager } from "./connection.ts";

export interface TaskActions {
  start(request: StartTaskRequest): Promise<StartTaskReply>;
  check(request: CheckTaskRequest): Promise<unknown>;
  uncheck(request: UncheckTaskRequest): Promise<unknown>;
  link(request: LinkTaskRequest): Promise<unknown>;
  clear(request?: ClearTasksRequest): Promise<unknown>;
  stop(address: string): Promise<unknown>;
  followUp(address: string, text: string, blocked: boolean): Promise<unknown>;
  answer(address: string, keys: readonly string[]): Promise<unknown>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  haptic(): Promise<unknown> | unknown;
  copy(value: string): Promise<void>;
}

export interface TaskActionEffects {
  confirm(options: ConfirmOptions): Promise<boolean>;
  haptic(): Promise<unknown> | unknown;
  copy(value: string): Promise<void>;
}

/** Adapt task bridge calls, core terminal calls and device effects to the task action port. */
export function createTaskActions(
  manager: Pick<ConnectionManager, "call"> | undefined,
  bridge: BridgeCalls,
  effects: TaskActionEffects = defaultEffects,
): TaskActions {
  const requireManager = () => {
    if (!manager) throw new Error("Not connected");
    return manager;
  };

  return {
    start: (request) => bridge.startTask(request),
    check: (request) => bridge.checkTask(request),
    uncheck: (request) => bridge.uncheckTask(request),
    link: (request) => bridge.linkTask(request),
    clear: (request) => bridge.clearTasks(request),
    stop: (address) => requireManager().call("terminal.kill", { terminal: address }),
    followUp: (address, text, blocked) =>
      requireManager().call("terminal.send", {
        terminal: address,
        text,
        ...(blocked ? { force: true } : {}),
      }),
    answer: (address, keys) =>
      requireManager().call("terminal.keys", { terminal: address, keys: [...keys] }),
    confirm: (options) => effects.confirm(options),
    haptic: () => effects.haptic(),
    copy: (value) => effects.copy(value),
  };
}

const defaultEffects: TaskActionEffects = {
  confirm: async (options) => {
    // Extensionless so Metro selects Confirm.web.ts on web.
    const { confirm } = await import("../ui/components/Confirm");
    return confirm(options);
  },
  haptic: async () => {
    const Haptics = await import("expo-haptics");
    return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  },
  copy: async (value) => {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(value);
  },
};
