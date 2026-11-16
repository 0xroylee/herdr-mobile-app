/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { claudeCodeApprovalPrompt } from "../../model/prompt/fixtures.ts";
import { keysForChoice } from "../../model/prompt/screen.ts";
import { promptKey, recognizePrompt } from "../../model/prompt.ts";
import { taskRecord } from "../../model/tasks.fixtures.ts";
import type { TaskRow } from "../../model/tasks.ts";
import { runCheckOff } from "../project/check-off.ts";
import {
  answerKeysForChoice,
  canAnswerPrompt,
  canFollowUpTask,
  canSwipeListActions,
  canUseSmartListActions,
  checkOffVisibleRows,
  DONE_ROW_DISMISS_MS,
  finishDoneRowCheck,
  finishDoneRowDismissal,
  groupNeedsYouRows,
  holdDoneRowForRemoval,
  InlinePromptAnswers,
  isDoneRowDismissalDue,
  isPromptSent,
  removalMatchesCurrentTurn,
  shouldClearDoneRowRemoval,
  smartListRows,
  taskDetailForList,
  taskDetailTone,
} from "./lists-view.ts";

function row(
  id: string,
  state: TaskRow["state"],
  timestamp: number,
  projectId = "work",
  turn = 1,
): TaskRow {
  return {
    id,
    record: taskRecord(id, { id, createdAt: timestamp, text: id }),
    address: `t-${id}`,
    terminal: {
      address: `t-${id}`,
      argv: ["claude"],
      cols: 80,
      created_ms: timestamp,
      cwd: "/work",
      labels: {},
      rows: 24,
      screen: "exact",
      state: "live",
      status: state === "needs-you" ? { state: "blocked" } : { state: "done" },
      status_ms: timestamp,
      turn,
    },
    title: id,
    program: { name: "Claude Code", iconKey: "claude" },
    state,
    createdAt: timestamp,
    timestamp,
    age: "1m",
    project: { id: projectId, name: projectId, folder: "/work" },
    fromHerdr: false,
    unlinked: false,
    matched: false,
    checked: state === "checked",
    question: state === "needs-you" ? "Allow this edit?" : undefined,
    stoppedText: state === "stopped" ? "Ended before it finished." : undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("smart list view logic", () => {
  test("groups Needs you by project in Herdr order and leaves fallback projects after it", () => {
    const rows = [
      row("other", "needs-you", 4, "other"),
      row("second", "needs-you", 3, "second"),
      row("first", "needs-you", 2, "first"),
      row("running", "running", 5, "first"),
    ];

    expect(
      groupNeedsYouRows(rows, ["first", "second"]).map(({ project, rows: items }) => [
        project.id,
        items.map(({ id }) => id),
      ]),
    ).toEqual([
      ["first", ["first"]],
      ["second", ["second"]],
      ["other", ["other"]],
    ]);
  });

  test("orders Done and Stopped newest first and uses the danger tone for Stopped", () => {
    const rows = [
      row("old", "done", 1),
      row("stopped", "stopped", 3),
      row("new", "done", 5),
      row("checked", "checked", 8),
    ];

    const done = smartListRows("done", rows);
    expect(done.map(({ id }) => id)).toEqual(["new", "stopped", "old"]);
    expect(done.map(taskDetailTone)).toEqual(["muted", "danger", "muted"]);
  });

  test("keeps Done details and Stopped danger text when swipe actions are unavailable", () => {
    const done = row("done", "done", 5);
    const stopped = row("stopped", "stopped", 4);

    expect(canSwipeListActions("done", "watch", "connected")).toBe(false);
    expect(canSwipeListActions("done", "control", "offline")).toBe(false);
    expect(taskDetailForList("done", done, "Completed the change.")).toBe("Completed the change.");
    expect(taskDetailForList("done", stopped, "cached summary")).toBe("Ended before it finished.");
    expect(taskDetailTone(stopped)).toBe("danger");
  });

  test("offers Follow up for Done but not Stopped tasks", () => {
    expect(canFollowUpTask(row("done", "done", 5))).toBe(true);
    expect(canFollowUpTask(row("stopped", "stopped", 4))).toBe(false);
  });

  test("uses the same answer keys as the prompt card for each recognized menu choice", () => {
    const prompt = recognizePrompt(
      claudeCodeApprovalPrompt.status,
      claudeCodeApprovalPrompt.screen,
      "claude",
    );

    expect(prompt).toBeDefined();
    expect(answerKeysForChoice(prompt, 0)).toEqual(keysForChoice(1, 0));
    expect(answerKeysForChoice(prompt, 2)).toEqual(keysForChoice(1, 2));
  });

  test("keeps Sent and the answer guard scoped to its menu until status or timeout moves on", () => {
    const status = { state: "blocked" } as const;
    const sent = { "first-menu": 10_000, "second-menu": 15_000 };

    expect(isPromptSent("first-menu", status, sent, 10_001)).toBe(true);
    expect(
      isPromptSent("first-menu", { state: "blocked", msg: "Updated prompt" }, sent, 10_001),
    ).toBe(true);
    expect(canAnswerPrompt("first-menu", status, undefined, sent, 10_001)).toBe(false);
    expect(isPromptSent("second-menu", status, sent, 15_001)).toBe(true);
    expect(canAnswerPrompt("second-menu", status, undefined, sent, 15_001)).toBe(false);
    expect(canAnswerPrompt("third-menu", status, undefined, sent, 15_001)).toBe(true);
    expect(isPromptSent("first-menu", status, sent, 30_000)).toBe(false);
    expect(isPromptSent("second-menu", status, sent, 30_000)).toBe(true);
    expect(isPromptSent("first-menu", { state: "working" }, sent, 10_001)).toBe(false);
  });

  test("recognizes and permits inline answers for an error-status Claude menu", () => {
    const status = { ...claudeCodeApprovalPrompt.status, state: "error" } as const;
    const prompt = recognizePrompt(status, claudeCodeApprovalPrompt.screen, "claude");
    const key = prompt === undefined ? undefined : promptKey(prompt);

    expect(prompt).toBeDefined();
    expect(key).toBeDefined();
    expect(canAnswerPrompt(key, status, undefined, {}, 10_000)).toBe(true);
    expect(isPromptSent(key, status, { [key ?? ""]: 10_000 }, 10_001)).toBe(true);
    expect(canAnswerPrompt(key, status, undefined, { [key ?? ""]: 10_000 }, 10_001)).toBe(false);
    expect(canAnswerPrompt(key, status, key, {}, 10_001)).toBe(false);
  });

  test("tracks Pending and Sent inline answers, ignores duplicate taps, and recovers from a failed send", async () => {
    const status = { state: "error" } as const;
    const key = "permission-menu";
    const answers = new InlinePromptAnswers(status);
    const pending = deferred<boolean>();
    let sendCount = 0;
    let now = 10_000;
    const send = async () => {
      sendCount += 1;
      return pending.promise;
    };

    const first = answers.answer(key, status, send, () => now);
    expect(answers.getSnapshot().pendingPromptKeys.has(key)).toBe(true);
    expect(await answers.answer(key, status, send, () => now)).toBe(false);
    expect(sendCount).toBe(1);

    now = 10_010;
    pending.resolve(true);
    expect(await first).toBe(true);
    expect(answers.getSnapshot().pendingPromptKeys.has(key)).toBe(false);
    expect(answers.getSnapshot().sent[key]).toBe(10_010);
    expect(answers.isSent(key, status, 10_011)).toBe(true);
    expect(answers.canAnswer(key, status, 10_011)).toBe(false);

    answers.setStatus({ state: "working" });
    expect(answers.getSnapshot().sent).toEqual({});

    const retry = new InlinePromptAnswers(status);
    expect(
      await retry.answer(
        key,
        status,
        async () => {
          throw new Error("send failed");
        },
        () => now,
      ),
    ).toBe(false);
    expect(retry.getSnapshot().pendingPromptKeys.has(key)).toBe(false);
    expect(retry.getSnapshot().sent).toEqual({});
    expect(retry.canAnswer(key, status, now)).toBe(true);
    expect(
      await retry.answer(
        key,
        status,
        async () => true,
        () => now,
      ),
    ).toBe(true);
    expect(retry.getSnapshot().sent[key]).toBe(now);
  });

  test("enables actions only for connected control devices and swipes only on Done", () => {
    expect(canUseSmartListActions("control", "connected")).toBe(true);
    expect(canUseSmartListActions("watch", "connected")).toBe(false);
    expect(canUseSmartListActions("control", "reconnecting")).toBe(false);
    expect(canSwipeListActions("done", "control", "connected")).toBe(true);
    expect(canSwipeListActions("running", "control", "connected")).toBe(false);
    expect(canSwipeListActions("needs-you", "control", "connected")).toBe(false);
  });

  test("checks every visible row through runCheckOff using its current terminal turn", async () => {
    const currentRows = new Map([
      ["first", row("first", "done", 1, "work", 4)],
      ["second", row("second", "stopped", 2, "work", 7)],
    ]);
    const checked: Array<{ id: string; turn: number }> = [];
    const result = await checkOffVisibleRows("machine", [...currentRows.values()], (identity) =>
      runCheckOff(identity, undefined, {
        current: () => ({
          activeMachineId: "machine",
          role: "control",
          connection: "connected",
          row: currentRows.get(identity.taskId),
        }),
        actions: {
          check: async (request) => {
            checked.push({
              id: "id" in request ? request.id : request.terminal,
              turn: request.turn,
            });
          },
          stop: async () => {},
        },
      }),
    );

    expect(result).toEqual({ completed: 2, result: "complete" });
    expect(checked).toEqual([
      { id: "first", turn: 4 },
      { id: "second", turn: 7 },
    ]);
  });

  test("dims for 600 ms, then removes; Reduce Motion removes immediately", () => {
    const done = row("done", "done", 5, "work", 4);
    const held = holdDoneRowForRemoval("machine", done, "Completed the change.");
    const checkedAt = 20_000;
    const dimmed = finishDoneRowCheck(held, checkedAt, false);

    expect(DONE_ROW_DISMISS_MS).toBe(600);
    expect(dimmed.checkedAt).toBe(checkedAt);
    expect(dimmed.leaveAfter).toBe(false);
    expect(isDoneRowDismissalDue(dimmed, checkedAt + 599)).toBe(false);
    expect(finishDoneRowDismissal(dimmed, checkedAt + 599)).toBeUndefined();
    expect(isDoneRowDismissalDue(dimmed, checkedAt + 600)).toBe(true);
    expect(finishDoneRowDismissal(dimmed, checkedAt + 600)?.leaveAfter).toBe(true);

    const reduced = finishDoneRowCheck(held, checkedAt, true);
    expect(reduced.checkedAt).toBe(checkedAt);
    expect(reduced.leaveAfter).toBe(true);
  });

  test("drops a check-off marker when the model advances to a newer Done turn", () => {
    const checkedTurn = row("same-task", "done", 5, "work", 4);
    const newerTurn = row("same-task", "done", 6, "work", 5);
    const removal = finishDoneRowCheck(
      holdDoneRowForRemoval("machine", checkedTurn, "Earlier completion."),
      20_000,
      false,
    );

    expect(removal.checkedTurn).toBe(4);
    expect(removalMatchesCurrentTurn(newerTurn, removal)).toBe(false);
    expect(shouldClearDoneRowRemoval(removal, newerTurn, new Set([newerTurn.id]))).toBe(true);
    expect(
      smartListRows("done", [newerTurn]).map(({ id, terminal }) => [id, terminal?.turn]),
    ).toEqual([["same-task", 5]]);
  });
});
