import type { Role, Status } from "@herdr-mobile/protocol";
import type { Prompt } from "../../model/prompt.ts";
import { SENT_TIMEOUT_MS } from "../../model/sent.ts";
import type { TaskProject, TaskRow } from "../../model/tasks.ts";
import type { SmartListKind } from "../../routes.ts";
import type { ConnectionState } from "../../store/core.ts";
import { promptAnswerBlockNotice } from "../agent/composer-routing.ts";
import type { TaskIdentity } from "../project/check-off.ts";

export type { SmartListKind } from "../../routes.ts";
export type CheckOffResult = "refused" | "ask" | "checked";
export const DONE_ROW_DISMISS_MS = 600;

export interface NeedsYouGroup {
  project: TaskProject;
  rows: TaskRow[];
}

export type PromptSentStates = Readonly<Record<string, number>>;

export interface InlinePromptAnswerSnapshot {
  pendingPromptKeys: ReadonlySet<string>;
  sent: PromptSentStates;
}

export interface DoneRowRemoval {
  machineId: string;
  row: TaskRow;
  summary: string;
  checkedAt: number | undefined;
  checkedTurn: number | undefined;
  leaveAfter: boolean;
}

/** Select the unchecked task states shown by each smart list. */
export function smartListRows(kind: SmartListKind, rows: readonly TaskRow[]): TaskRow[] {
  if (kind === "needs-you") return rows.filter((row) => row.state === "needs-you");
  if (kind === "running") return rows.filter((row) => row.state === "running");
  return [...rows]
    .filter((row) => row.state === "done" || row.state === "stopped")
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        right.createdAt - left.createdAt ||
        left.id.localeCompare(right.id),
    );
}

/** Group blocked rows by stable project id, following Herdr's space order first. */
export function groupNeedsYouRows(
  rows: readonly TaskRow[],
  projectOrder: readonly string[] = [],
): NeedsYouGroup[] {
  const groups = new Map<string, NeedsYouGroup>();
  for (const row of smartListRows("needs-you", rows)) {
    const group = groups.get(row.project.id) ?? { project: row.project, rows: [] };
    group.rows.push(row);
    groups.set(row.project.id, group);
  }

  const order = new Map(projectOrder.map((id, index) => [id, index]));
  return [...groups.values()].sort((left, right) => {
    const leftOrder = order.get(left.project.id);
    const rightOrder = order.get(right.project.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    }
    return 0;
  });
}

/** Preserve the prompt card's recognized menu keys for the corresponding inline choice. */
export function answerKeysForChoice(
  prompt: Prompt | undefined,
  index: number,
): readonly string[] | undefined {
  return prompt?.choices[index]?.keys;
}

/** Needs-you answers are guarded per menu and stop showing after status moves on or 20 seconds. */
export function isPromptSent(
  promptKey: string | undefined,
  status: Status | null | undefined,
  sent: PromptSentStates,
  now: number,
): boolean {
  const sentAt = promptKey === undefined ? undefined : sent[promptKey];
  return (
    promptKey !== undefined &&
    isNeedsYouStatus(status) &&
    sentAt !== undefined &&
    now - sentAt < SENT_TIMEOUT_MS
  );
}

export function canAnswerPrompt(
  promptKey: string | undefined,
  status: Status | null | undefined,
  pendingPromptKey: string | undefined,
  sent: PromptSentStates,
  now: number,
): boolean {
  if (promptKey === undefined || !isNeedsYouStatus(status)) return false;
  const sentPromptKey = isPromptSent(promptKey, status, sent, now) ? promptKey : undefined;
  return promptAnswerBlockNotice(promptKey, { pendingPromptKey, sentPromptKey }) === undefined;
}

/** Blocked and error are both model states for the Needs you list. */
export function isNeedsYouStatus(status: Status | null | undefined): boolean {
  return status?.state === "blocked" || status?.state === "error";
}

/** Keep per-menu Pending and Sent guards synchronized with inline list answers. */
export class InlinePromptAnswers {
  private snapshot: InlinePromptAnswerSnapshot = { pendingPromptKeys: new Set(), sent: {} };
  private status: Status | null | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(status?: Status | null) {
    this.status = status;
  }

  getSnapshot = (): InlinePromptAnswerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setStatus(status: Status | null | undefined): void {
    this.status = status;
    if (isNeedsYouStatus(status)) return;
    this.setSnapshot({ ...this.snapshot, sent: {} });
  }

  canAnswer(
    promptKey: string | undefined,
    status: Status | null | undefined,
    now: number,
  ): boolean {
    return canAnswerPrompt(
      promptKey,
      status,
      promptKey !== undefined && this.snapshot.pendingPromptKeys.has(promptKey)
        ? promptKey
        : undefined,
      this.snapshot.sent,
      now,
    );
  }

  isSent(promptKey: string | undefined, status: Status | null | undefined, now: number): boolean {
    return isPromptSent(promptKey, status, this.snapshot.sent, now);
  }

  expireSent(now: number): void {
    if (!isNeedsYouStatus(this.status)) {
      this.setSnapshot({ ...this.snapshot, sent: {} });
      return;
    }
    const sent = Object.fromEntries(
      Object.entries(this.snapshot.sent).filter(([, sentAt]) => now - sentAt < SENT_TIMEOUT_MS),
    );
    if (Object.keys(sent).length !== Object.keys(this.snapshot.sent).length) {
      this.setSnapshot({ ...this.snapshot, sent });
    }
  }

  async answer(
    promptKey: string,
    status: Status | null | undefined,
    send: () => Promise<boolean>,
    now: () => number = Date.now,
  ): Promise<boolean> {
    if (!this.canAnswer(promptKey, status, now())) return false;

    const pendingPromptKeys = new Set(this.snapshot.pendingPromptKeys);
    pendingPromptKeys.add(promptKey);
    this.setSnapshot({ ...this.snapshot, pendingPromptKeys });

    let accepted = false;
    try {
      accepted = await send();
    } catch {
      accepted = false;
    }

    const nextPendingPromptKeys = new Set(this.snapshot.pendingPromptKeys);
    nextPendingPromptKeys.delete(promptKey);
    const sent =
      accepted && isNeedsYouStatus(this.status)
        ? { ...this.snapshot.sent, [promptKey]: now() }
        : this.snapshot.sent;
    this.setSnapshot({ pendingPromptKeys: nextPendingPromptKeys, sent });
    return accepted;
  }

  private setSnapshot(snapshot: InlinePromptAnswerSnapshot): void {
    if (
      snapshot.pendingPromptKeys === this.snapshot.pendingPromptKeys &&
      snapshot.sent === this.snapshot.sent
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function canUseSmartListActions(
  role: Role | undefined,
  connection: ConnectionState,
): boolean {
  return role === "control" && connection === "connected";
}

export function canSwipeListActions(
  kind: SmartListKind,
  role: Role | undefined,
  connection: ConnectionState,
): boolean {
  return kind === "done" && canUseSmartListActions(role, connection);
}

export function taskDetailTone(row: TaskRow): "danger" | "muted" {
  return row.state === "stopped" ? "danger" : "muted";
}

/** Compute details before deciding whether a row can be swiped. */
export function taskDetailForList(
  kind: SmartListKind,
  row: TaskRow,
  summary: string | undefined,
): string | undefined {
  if (kind === "running" && row.terminal?.status == null) return "Waiting for status";
  if (kind !== "done") return undefined;
  return row.state === "stopped" ? row.stoppedText : summary;
}

export function canFollowUpTask(row: TaskRow): boolean {
  return row.state === "done";
}

export function holdDoneRowForRemoval(
  machineId: string,
  row: TaskRow,
  summary: string,
): DoneRowRemoval {
  return {
    machineId,
    row,
    summary,
    checkedAt: undefined,
    checkedTurn: undefined,
    leaveAfter: false,
  };
}

export function finishDoneRowCheck(
  removal: DoneRowRemoval,
  now: number,
  reducedMotion: boolean,
): DoneRowRemoval {
  return {
    ...removal,
    row: { ...removal.row, state: "checked", checked: true },
    checkedAt: now,
    checkedTurn: removal.row.terminal?.turn ?? 0,
    leaveAfter: reducedMotion,
  };
}

export function markDoneRowRemoved(removal: DoneRowRemoval): DoneRowRemoval {
  return { ...removal, leaveAfter: true };
}

export function isDoneRowDismissalDue(removal: DoneRowRemoval, now: number): boolean {
  return removal.checkedAt !== undefined && now - removal.checkedAt >= DONE_ROW_DISMISS_MS;
}

export function finishDoneRowDismissal(
  removal: DoneRowRemoval,
  now: number,
): DoneRowRemoval | undefined {
  return isDoneRowDismissalDue(removal, now) ? markDoneRowRemoved(removal) : undefined;
}

/** A leave marker applies only until the model advances beyond its checked turn. */
export function removalMatchesCurrentTurn(row: TaskRow, removal: DoneRowRemoval): boolean {
  return removal.checkedTurn === undefined || (row.terminal?.turn ?? 0) <= removal.checkedTurn;
}

export function shouldClearDoneRowRemoval(
  removal: DoneRowRemoval,
  currentRow: TaskRow | undefined,
  visibleDoneTaskIds: ReadonlySet<string>,
): boolean {
  if (currentRow !== undefined && !removalMatchesCurrentTurn(currentRow, removal)) return true;
  return removal.leaveAfter && !visibleDoneTaskIds.has(removal.row.id);
}

/** Check every row visible when Check off all was chosen, stopping if a row now needs review. */
export async function checkOffVisibleRows(
  machineId: string,
  rows: readonly Pick<TaskRow, "id">[],
  runCheckOff: (identity: TaskIdentity) => Promise<CheckOffResult>,
): Promise<{ completed: number; result: CheckOffResult | "complete" }> {
  let completed = 0;
  for (const row of rows) {
    const result = await runCheckOff({ machineId, taskId: row.id });
    if (result !== "checked") return { completed, result };
    completed += 1;
  }
  return { completed, result: "complete" };
}
