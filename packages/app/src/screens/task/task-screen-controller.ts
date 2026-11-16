import type { LinkTaskRequest, Role } from "@herdr-mobile/protocol";
import { type Prompt, promptKey } from "../../model/prompt.ts";
import type { DerivedTasks, TaskRow, TaskState } from "../../model/tasks.ts";
import { BridgeApiError } from "../../net/bridge-api.ts";
import type { TaskActions } from "../../net/task-actions.ts";
import type { ConnectionState } from "../../store/core.ts";
import { type AgentActionPort, interruptAgent } from "../agent/actions.ts";
import { promptAnswerBlockNotice, routeComposerText } from "../agent/composer-routing.ts";
import { KeyQueue } from "../agent/key-queue.ts";
import { PromptAnswer } from "../agent/prompt-answer.ts";
import type { CheckOffChoice, TaskIdentity } from "../project/check-off.ts";

export type TaskStateTone = "working" | "blocked" | "done" | "danger" | "dim";

export interface TaskStateStrip {
  label: string;
  mark: "working" | "blockedCompact" | "done" | "stopped" | "checked" | "idle";
  tone: TaskStateTone;
}

export type TaskMenuActionId =
  | "open-terminal"
  | "interrupt"
  | "stop-agent"
  | "check-off"
  | "copy-address";

export interface TaskMenuAction {
  id: TaskMenuActionId;
  label: "Open terminal" | "Interrupt" | "Stop agent" | "Check off" | "Copy address";
  destructive?: boolean;
}

export type TaskTerminalPresentation = "starting" | "not-found" | "missing" | undefined;

export interface TaskScreenOutput {
  machineId: string;
  address: string;
  refreshKey: string;
  generation: number;
  rows: readonly string[];
}

export interface TaskScreenReadVersion {
  machineId: string | null;
  connected: boolean;
  refreshKey: string | undefined;
  terminal: TaskRow["terminal"];
  reader: object | undefined;
}

export interface TaskScreenSnapshot {
  activeMachineId: string | null;
  role: Role | undefined;
  connection: ConnectionState | undefined;
  row: TaskRow | undefined;
  prompt: Prompt | undefined;
  screenGeneration: number;
}

export interface TaskScreenRuntime {
  current(identity: TaskIdentity): TaskScreenSnapshot;
  actions: TaskActions;
  runCheckOff(
    identity: TaskIdentity,
    choice?: CheckOffChoice,
  ): Promise<"refused" | "ask" | "checked">;
  markSent(): void;
}

export type TaskComposerResult = { kind: "sent" } | { kind: "refused"; notice?: string };

export type TaskScreenActionResult =
  | { kind: "refused" }
  | { kind: "cancelled" }
  | { kind: "open-terminal"; address: string }
  | { kind: "check-off"; result: "refused" | "ask" | "checked" }
  | { kind: "copied" }
  | { kind: "interrupted" }
  | { kind: "stopped" };

export const UNLINKED_TERMINAL_TIMEOUT_MS = 2 * 60_000;

const menuLabels: Record<TaskMenuActionId, TaskMenuAction["label"]> = {
  "open-terminal": "Open terminal",
  interrupt: "Interrupt",
  "stop-agent": "Stop agent",
  "check-off": "Check off",
  "copy-address": "Copy address",
};

/** State text and mark for the task detail strip. */
export function taskStateStrip(state: TaskState, age: string): TaskStateStrip {
  switch (state) {
    case "needs-you":
      return { label: `Needs you · ${age}`, mark: "blockedCompact", tone: "blocked" };
    case "running":
      return { label: `Running · ${age}`, mark: "working", tone: "working" };
    case "done":
      return { label: `Done · ${age}`, mark: "done", tone: "done" };
    case "stopped":
      return { label: `Stopped · ${age}`, mark: "stopped", tone: "danger" };
    case "checked":
      return { label: `Checked off · ${age}`, mark: "checked", tone: "dim" };
    case "not-started":
      return { label: `Not started · ${age}`, mark: "idle", tone: "dim" };
  }
}

/** Key output reads by address, turn and status so new reports invalidate the cached screen. */
export function latestOutputRefreshKey(row: TaskRow | undefined): string | undefined {
  if (row?.address === undefined) return undefined;
  return JSON.stringify([row.address, row.terminal?.turn ?? null, row.terminal?.status ?? null]);
}

/** Keep the last eight visible, non-blank rows from a terminal screen read. */
export function latestOutputRows(rows: readonly string[]): string[] {
  return rows.filter((row) => row.trim().length > 0).slice(-8);
}

/** Decide which terminal placeholder belongs under the task details. */
export function taskTerminalPresentation(
  row: TaskRow | undefined,
  now: number,
): TaskTerminalPresentation {
  if (row === undefined) return undefined;
  if (row.unlinked) {
    return now - row.createdAt < UNLINKED_TERMINAL_TIMEOUT_MS ? "starting" : "not-found";
  }
  if (row.address !== undefined && row.terminal === undefined) return "missing";
  return undefined;
}

/** Keep output visible while allowing prompt recognition only for the current screen read. */
export function answerableTaskScreenRows(
  row: TaskRow | undefined,
  machineId: string | null,
  refreshKey: string | undefined,
  generation: number,
  output: TaskScreenOutput | undefined,
): readonly string[] {
  if (
    row?.address === undefined ||
    row.terminal === undefined ||
    machineId === null ||
    refreshKey === undefined ||
    output === undefined ||
    output.machineId !== machineId ||
    output.address !== row.address ||
    output.refreshKey !== refreshKey ||
    output.generation !== generation
  ) {
    return [];
  }
  return output.rows;
}

/** Resolve a synthetic terminal route after its address is claimed by a task record. */
export function taskRowForRoute(
  taskId: string,
  tasks: Pick<DerivedTasks, "rows" | "taskFor">,
): TaskRow | undefined {
  const exact = tasks.taskFor(taskId);
  if (exact !== undefined || !taskId.startsWith("t:")) return exact;
  const address = taskId.slice(2);
  return address.length === 0 ? undefined : tasks.rows.find((row) => row.address === address);
}

/** Follow-up is writable for a linked task unless it is stopped or checked off. */
export function canFollowUp(
  row: TaskRow | undefined,
  role: Role | undefined,
  connection: ConnectionState | undefined,
): boolean {
  return (
    row !== undefined &&
    row.address !== undefined &&
    row.terminal !== undefined &&
    role === "control" &&
    connection === "connected" &&
    row.state !== "stopped" &&
    row.state !== "checked" &&
    row.state !== "not-started"
  );
}

/** Only Needs you sends need terminal.send's force flag. */
export function followUpNeedsForce(row: TaskRow | undefined): boolean {
  return row?.state === "needs-you";
}

/** Menu choices are derived from the current state, role and connection. */
export function taskMenuItems(
  row: TaskRow | undefined,
  role: Role | undefined,
  connection: ConnectionState | undefined,
  now: number,
): TaskMenuAction[] {
  if (row === undefined || connection !== "connected") return [];

  const ids: TaskMenuActionId[] = [];
  if (row.address !== undefined && row.terminal !== undefined) ids.push("open-terminal");

  if (role === "control") {
    const agentIsActive =
      (row.state === "running" || row.state === "needs-you") &&
      row.terminal?.state === "live" &&
      row.terminal.reason == null;
    if (agentIsActive) ids.push("interrupt", "stop-agent");

    const terminalPresentation = taskTerminalPresentation(row, now);
    const canCheck = row.state !== "checked" && row.state !== "not-started";
    if (canCheck && (!row.unlinked || terminalPresentation === "not-found")) {
      ids.push("check-off");
    }
  }

  if (row.address !== undefined) ids.push("copy-address");
  return ids.map((id) => ({
    id,
    label: menuLabels[id],
    ...(id === "stop-agent" || id === "check-off" ? { destructive: id === "stop-agent" } : {}),
  }));
}

/** Claim a matched record once, and only while a control device is connected. */
export class MatchedTaskLinkController {
  private readonly claimed = new Set<string>();

  claim(
    row: TaskRow | undefined,
    role: Role | undefined,
    connection: ConnectionState | undefined,
  ): LinkTaskRequest | undefined {
    if (
      row?.matched !== true ||
      row.record === undefined ||
      row.record.terminal !== undefined ||
      row.address === undefined ||
      role !== "control" ||
      connection !== "connected" ||
      this.claimed.has(row.record.id)
    ) {
      return undefined;
    }

    this.claimed.add(row.record.id);
    return { id: row.record.id, terminal: row.address };
  }
}

/** Return no message when the bridge says another client already linked this task. */
export function taskLinkErrorMessage(error: unknown): string | undefined {
  if (error instanceof BridgeApiError && error.status === 409 && error.code === "task_linked") {
    return undefined;
  }
  return error instanceof Error ? error.message : "Couldn't link this task to its terminal.";
}

/** The done-list swipe passes this route value to focus the task's follow-up field. */
export function shouldFocusFollowUp(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === "followup";
}

/** Present the task's creation time and source in the task facts. */
export function taskStartedFact(row: TaskRow, now: number): string {
  const started = new Date(row.createdAt);
  const today = new Date(now);
  const isToday =
    started.getFullYear() === today.getFullYear() &&
    started.getMonth() === today.getMonth() &&
    started.getDate() === today.getDate();
  const time = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(started);
  const date = isToday
    ? "Today"
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(started);
  const source =
    row.record?.origin === "herdr" || row.fromHerdr
      ? "from Herdr"
      : `from ${row.record?.createdBy?.deviceName?.trim() || "Phone"}`;
  return `${date}, ${time} ${source}`;
}

/** Coordinates task screen actions through the task action port and current-state reader. */
export class TaskScreenController {
  readonly promptAnswer: PromptAnswer;
  private readonly getRuntime: () => TaskScreenRuntime;
  private readonly queue = new KeyQueue();
  private pendingPromptKey: string | undefined;
  private answeredPromptKey: string | undefined;

  constructor(getRuntime: () => TaskScreenRuntime) {
    this.getRuntime = getRuntime;
    this.promptAnswer = new PromptAnswer(this.queue);
  }

  get answeredKey(): string | undefined {
    return this.answeredPromptKey;
  }

  isPromptAnswered(key: string): boolean {
    return this.answeredPromptKey === key;
  }

  clearAnsweredPrompt(): void {
    this.answeredPromptKey = undefined;
  }

  async submitComposer(
    identity: TaskIdentity,
    text: string,
    options: {
      optionsOffered: boolean;
      promptKey: string | undefined;
      screenGeneration: number;
    },
  ): Promise<TaskComposerResult> {
    const snapshot = this.current(identity);
    if (snapshot === undefined) return { kind: "refused" };

    const currentPromptKey = snapshot.prompt === undefined ? undefined : promptKey(snapshot.prompt);
    if (
      snapshot.screenGeneration !== options.screenGeneration ||
      currentPromptKey !== options.promptKey
    ) {
      return { kind: "refused", notice: "The task changed. Wait for it to refresh." };
    }
    if (options.optionsOffered && currentPromptKey === undefined) return { kind: "refused" };

    const route = routeComposerText(text, snapshot.prompt, options.optionsOffered, {
      pendingPromptKey: this.pendingPromptKey,
      sentPromptKey: this.answeredPromptKey,
    });
    if (route.kind === "refuse") return { kind: "refused", notice: route.notice };
    if (route.kind === "answer") {
      const key = currentPromptKey;
      if (key === undefined) return { kind: "refused" };
      return this.answerPrompt(identity, route.keys, {
        promptKey: key,
        screenGeneration: snapshot.screenGeneration,
      });
    }

    const row = snapshot.row;
    if (row === undefined || !canFollowUp(row, snapshot.role, snapshot.connection)) {
      return { kind: "refused" };
    }
    const address = row.address;
    if (address === undefined) return { kind: "refused" };
    await this.getRuntime().actions.followUp(address, text, followUpNeedsForce(row));
    this.getRuntime().markSent();
    return { kind: "sent" };
  }

  async answerPrompt(
    identity: TaskIdentity,
    keys: readonly string[],
    expected: { promptKey: string; screenGeneration: number },
  ): Promise<TaskComposerResult> {
    const initial = this.current(identity);
    if (!this.canAnswer(initial, identity, expected)) return { kind: "refused" };

    const notice = promptAnswerBlockNotice(expected.promptKey, {
      pendingPromptKey: this.pendingPromptKey,
      sentPromptKey: this.answeredPromptKey,
    });
    if (notice !== undefined) return { kind: "refused", notice };

    const address = initial.row?.address;
    if (address === undefined) return { kind: "refused" };
    this.pendingPromptKey = expected.promptKey;
    try {
      const accepted = await this.promptAnswer.answer(keys, async (queuedKeys) => {
        const current = this.current(identity);
        if (!this.canAnswer(current, identity, expected) || current.row?.address !== address) {
          return false;
        }
        await this.getRuntime().actions.answer(address, queuedKeys);
        return true;
      });
      if (!accepted) return { kind: "refused" };
      this.answeredPromptKey = expected.promptKey;
      this.getRuntime().markSent();
      return { kind: "sent" };
    } finally {
      if (this.pendingPromptKey === expected.promptKey) this.pendingPromptKey = undefined;
    }
  }

  async selectMenuAction(
    identity: TaskIdentity,
    actionId: TaskMenuActionId,
  ): Promise<TaskScreenActionResult> {
    const initial = this.current(identity);
    if (!this.menuActionAvailable(initial, actionId)) return { kind: "refused" };
    const row = initial.row;
    const address = row?.address;

    if (actionId === "open-terminal") {
      return address === undefined ? { kind: "refused" } : { kind: "open-terminal", address };
    }
    if (actionId === "check-off") {
      const result = await this.getRuntime().runCheckOff(identity);
      return { kind: "check-off", result };
    }
    if (actionId === "copy-address") {
      if (address === undefined) return { kind: "refused" };
      await this.getRuntime().actions.copy(address);
      return { kind: "copied" };
    }
    if (address === undefined) return { kind: "refused" };
    if (actionId === "interrupt") return this.interrupt(identity, address, initial);

    const confirmed = await this.getRuntime().actions.confirm({
      title: "Stop this agent?",
      cancelLabel: "Cancel",
      confirmLabel: "Stop agent",
    });
    if (!confirmed) return { kind: "cancelled" };

    const latest = this.current(identity);
    if (!this.menuActionAvailable(latest, "stop-agent") || latest.row?.address !== address) {
      return { kind: "refused" };
    }
    await this.getRuntime().actions.stop(address);
    return { kind: "stopped" };
  }

  async checkOff(
    identity: TaskIdentity,
    choice?: CheckOffChoice,
  ): Promise<"refused" | "ask" | "checked"> {
    if (this.current(identity) === undefined) return "refused";
    return this.getRuntime().runCheckOff(identity, choice);
  }

  async copyAddress(address: string): Promise<void> {
    await this.getRuntime().actions.copy(address);
  }

  private current(identity: TaskIdentity): TaskScreenSnapshot | undefined {
    const snapshot = this.getRuntime().current(identity);
    return snapshot.activeMachineId === identity.machineId && snapshot.row?.id === identity.taskId
      ? snapshot
      : undefined;
  }

  private canAnswer(
    snapshot: TaskScreenSnapshot | undefined,
    identity: TaskIdentity,
    expected: { promptKey: string; screenGeneration: number },
  ): snapshot is TaskScreenSnapshot & { row: TaskRow; prompt: Prompt } {
    return (
      snapshot !== undefined &&
      snapshot.role === "control" &&
      snapshot.connection === "connected" &&
      snapshot.row?.state === "needs-you" &&
      snapshot.row.address !== undefined &&
      snapshot.row.terminal !== undefined &&
      snapshot.prompt !== undefined &&
      promptKey(snapshot.prompt) === expected.promptKey &&
      snapshot.screenGeneration === expected.screenGeneration &&
      snapshot.activeMachineId === identity.machineId &&
      snapshot.row.id === identity.taskId
    );
  }

  private menuActionAvailable(
    snapshot: TaskScreenSnapshot | undefined,
    actionId: TaskMenuActionId,
  ): snapshot is TaskScreenSnapshot & { row: TaskRow } {
    return (
      snapshot !== undefined &&
      taskMenuItems(snapshot.row, snapshot.role, snapshot.connection, Date.now()).some(
        ({ id }) => id === actionId,
      )
    );
  }

  private async interrupt(
    identity: TaskIdentity,
    address: string,
    captured: TaskScreenSnapshot,
  ): Promise<TaskScreenActionResult> {
    let cancelled = false;
    const port: AgentActionPort = {
      confirm: async (options) => {
        const confirmed = await this.getRuntime().actions.confirm(options);
        cancelled = !confirmed;
        return confirmed;
      },
      haptic: () => this.getRuntime().actions.haptic(),
      copy: (value) => this.getRuntime().actions.copy(value),
      sendText: async () => {
        throw new Error("Task actions do not send terminal text through the interrupt port.");
      },
      sendKeys: async (sentAddress, keys) => {
        const current = this.current(identity);
        if (
          sentAddress !== address ||
          !this.menuActionAvailable(current, "interrupt") ||
          current.row.address !== address ||
          current.screenGeneration !== captured.screenGeneration ||
          promptIdentity(current.prompt) !== promptIdentity(captured.prompt)
        ) {
          throw new Error("The task changed before the interrupt was sent.");
        }
        await this.getRuntime().actions.answer(address, keys);
      },
      kill: async () => {
        throw new Error("Task interrupt does not stop the terminal.");
      },
      takeOver: async () => {
        throw new Error("Task interrupt does not take over the terminal.");
      },
    };

    const interrupted = await this.queue.send(["ctrl+c"], async () =>
      interruptAgent(port, address),
    );
    if (interrupted) return { kind: "interrupted" };
    return cancelled ? { kind: "cancelled" } : { kind: "refused" };
  }
}

/** Consume the route focus request once, after the input actually receives focus. */
export class TaskFocusController {
  private taskId: string | undefined;
  private consumed = false;

  consume(taskId: string, onConsumed: () => void): boolean {
    if (this.taskId !== taskId) {
      this.taskId = taskId;
      this.consumed = false;
    }
    if (this.consumed) return false;
    this.consumed = true;
    onConsumed();
    return true;
  }
}

/** Assign a new generation whenever a screen read's machine or refresh inputs change. */
export class TaskScreenReadGeneration {
  private generation = 0;
  private previous: TaskScreenReadVersion | undefined;

  next(version: TaskScreenReadVersion): number {
    const previous = this.previous;
    if (
      previous === undefined ||
      previous.machineId !== version.machineId ||
      previous.connected !== version.connected ||
      previous.refreshKey !== version.refreshKey ||
      previous.terminal !== version.terminal ||
      previous.reader !== version.reader
    ) {
      this.previous = version;
      this.generation += 1;
    }
    return this.generation;
  }
}

function promptIdentity(prompt: Prompt | undefined): string | undefined {
  return prompt === undefined ? undefined : promptKey(prompt);
}
