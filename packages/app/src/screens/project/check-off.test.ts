/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TaskRow } from "../../model/tasks.ts";
import {
  type CheckOffCurrent,
  checkOffSheetOptions,
  checkOffSheetOptionsFor,
  needsCheckOffSheet,
  resolveTaskRow,
  runCheckOff,
  type TaskIdentity,
} from "./check-off.ts";

const identity: TaskIdentity = { machineId: "machine-1", taskId: "task-running" };

describe("check-off sheet", () => {
  for (const state of [
    "running",
    "needs-you",
    "done",
    "stopped",
    "checked",
    "not-started",
  ] as const) {
    test(`chooses the sheet behavior for ${state}`, () => {
      const task = row(state);
      expect(needsCheckOffSheet(task, "control")).toBe(
        state === "running" || state === "needs-you",
      );
      expect(checkOffSheetOptions(task, "control").map(({ label }) => label)).toEqual(
        state === "running" || state === "needs-you"
          ? ["Stop agent and check off", "Check off, keep it running", "Cancel"]
          : [],
      );
      expect(needsCheckOffSheet(task, "watch")).toBe(false);
      expect(checkOffSheetOptions(task, "watch")).toEqual([]);
    });
  }

  test("omits stopping when a running task has no linked terminal", () => {
    const task = row("running", { address: undefined, record: true });
    expect(checkOffSheetOptions(task, "control").map(({ id }) => id)).toEqual([
      "keep-running",
      "cancel",
    ]);
  });

  test("hides sheet write choices after disconnect, machine switch, or role change", () => {
    const task = row("running");
    expect(
      checkOffSheetOptionsFor(task, "machine-1", "machine-1", "control", "connected").map(
        ({ id }) => id,
      ),
    ).toEqual(["stop", "keep-running", "cancel"]);
    expect(
      checkOffSheetOptionsFor(task, "machine-1", "machine-1", "control", "reconnecting"),
    ).toEqual([]);
    expect(checkOffSheetOptionsFor(task, "machine-1", "machine-2", "control", "connected")).toEqual(
      [],
    );
    expect(checkOffSheetOptionsFor(task, "machine-1", "machine-1", "watch", "connected")).toEqual(
      [],
    );
  });
});

describe("runCheckOff", () => {
  test("asks when the current row is Running, even if the tapped row was Done", async () => {
    const tapped = row("done");
    const current = row("running", { id: tapped.id });
    const calls: unknown[] = [];

    expect(tapped.state).toBe("done");
    await expect(
      runCheckOff({ ...identity, taskId: tapped.id }, undefined, {
        current: () => snapshot(current),
        actions: actions(calls),
      }),
    ).resolves.toBe("ask");
    expect(calls).toEqual([]);
  });

  test("cancels without writing and refuses watch, wrong-machine, disconnected, and missing rows", async () => {
    const calls: unknown[] = [];
    const task = row("running");
    const deps = (current: CheckOffCurrent) => ({
      current: () => current,
      actions: actions(calls),
    });

    await expect(runCheckOff(identity, "cancel", deps(snapshot(task)))).resolves.toBe("refused");
    await expect(
      runCheckOff(identity, "stop", deps(snapshot(task, { role: "watch" }))),
    ).resolves.toBe("refused");
    await expect(
      runCheckOff(identity, "stop", deps(snapshot(task, { activeMachineId: "machine-2" }))),
    ).resolves.toBe("refused");
    await expect(
      runCheckOff(identity, "stop", deps(snapshot(task, { connection: "reconnecting" }))),
    ).resolves.toBe("refused");
    await expect(runCheckOff(identity, "stop", deps(snapshot(undefined)))).resolves.toBe("refused");
    await expect(runCheckOff(identity, undefined, deps(snapshot(row("checked"))))).resolves.toBe(
      "refused",
    );
    await expect(
      runCheckOff(identity, undefined, deps(snapshot(row("not-started")))),
    ).resolves.toBe("refused");
    expect(calls).toEqual([]);
  });

  for (const [name, changes] of [
    ["disconnect", { connection: "reconnecting" }],
    ["machine switch", { activeMachineId: "machine-2" }],
    ["role change", { role: "watch" }],
    ["row removal", { row: undefined }],
  ] as const) {
    test(`refuses the check if ${name} happens while stop is pending`, async () => {
      let current = snapshot(row("running", { turn: 4 }));
      let enterStop!: () => void;
      let releaseStop!: () => void;
      const stopEntered = new Promise<void>((resolve) => {
        enterStop = resolve;
      });
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const calls: unknown[] = [];
      const operation = runCheckOff(identity, "stop", {
        current: () => current,
        actions: {
          stop: async (address) => {
            calls.push(["stop", address]);
            enterStop();
            await stopGate;
          },
          check: async (request) => calls.push(["check", request]),
        },
      });

      await stopEntered;
      current = { ...current, ...changes };
      releaseStop();

      await expect(operation).resolves.toBe("refused");
      expect(calls).toEqual([["stop", "terminal-running"]]);
    });
  }

  test("uses the current turn after stop returns", async () => {
    let current = snapshot(row("running", { turn: 4 }));
    let enterStop!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      enterStop = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const calls: unknown[] = [];
    const operation = runCheckOff(identity, "stop", {
      current: () => current,
      actions: {
        stop: async (address) => {
          calls.push(["stop", address]);
          enterStop();
          await stopGate;
        },
        check: async (request) => calls.push(["check", request]),
      },
    });

    await stopEntered;
    current = snapshot(row("done", { address: "terminal-running", turn: 5, id: identity.taskId }));
    releaseStop();

    await expect(operation).resolves.toBe("checked");
    expect(calls).toEqual([
      ["stop", "terminal-running"],
      ["check", { id: identity.taskId, turn: 5 }],
    ]);
  });

  test("stops a task that is Done when Stop is submitted, then checks its current turn", async () => {
    let current = snapshot(row("done", { id: identity.taskId, turn: 4 }));
    let enterStop!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      enterStop = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const calls: unknown[] = [];
    const operation = runCheckOff(identity, "stop", {
      current: () => current,
      actions: {
        stop: async (address) => {
          calls.push(["stop", address]);
          enterStop();
          await stopGate;
        },
        check: async (request) => calls.push(["check", request]),
      },
    });

    await stopEntered;
    current = snapshot(row("done", { address: "terminal-running", id: identity.taskId, turn: 5 }));
    releaseStop();

    await expect(operation).resolves.toBe("checked");
    expect(calls).toEqual([
      ["stop", "terminal-done"],
      ["check", { id: identity.taskId, turn: 5 }],
    ]);
  });

  test("checks Done and Stopped without asking or stopping", async () => {
    for (const state of ["done", "stopped"] as const) {
      const calls: unknown[] = [];
      const task = row(state);
      await expect(
        runCheckOff({ ...identity, taskId: task.id }, undefined, {
          current: () => snapshot(task),
          actions: actions(calls),
        }),
      ).resolves.toBe("checked");
      expect(calls).toEqual([["check", { id: task.id, turn: 0 }]]);
    }
  });

  test("checks an unrecorded Herdr task by its terminal address", async () => {
    const calls: unknown[] = [];
    const task = row("done", { record: false });
    await expect(
      runCheckOff({ ...identity, taskId: task.id }, undefined, {
        current: () => snapshot(task),
        actions: actions(calls),
      }),
    ).resolves.toBe("checked");
    expect(calls).toEqual([["check", { terminal: "terminal-done", turn: 0 }]]);
  });

  test("resolves a delayed task id against the current task rows", () => {
    const done = row("done");
    const running = { ...done, state: "running" as const };
    expect(resolveTaskRow(done.id, [running])).toBe(running);
    expect(resolveTaskRow(done.id, [])).toBeUndefined();
  });
});

function snapshot(
  row: TaskRow | undefined,
  overrides: Partial<CheckOffCurrent> = {},
): CheckOffCurrent {
  return {
    activeMachineId: "machine-1",
    role: "control",
    connection: "connected",
    row,
    ...overrides,
  };
}

function actions(calls: unknown[]) {
  return {
    stop: async (address: string) => calls.push(["stop", address]),
    check: async (request: unknown) => calls.push(["check", request]),
  };
}

function row(
  state: TaskRow["state"],
  options: { address?: string; id?: string; record?: boolean; turn?: number } = {},
): TaskRow {
  const id = options.id ?? `task-${state}`;
  const address = Object.hasOwn(options, "address") ? options.address : `terminal-${state}`;
  const record = options.record === false ? undefined : { id };
  return {
    id,
    record: record as unknown as TaskRow["record"],
    address,
    terminal:
      options.turn === undefined
        ? undefined
        : ({ turn: options.turn } as unknown as TaskRow["terminal"]),
    title: state,
    program: { name: "Claude Code", iconKey: "claude" },
    state,
    createdAt: 1,
    timestamp: 1,
    age: "1m",
    project: { id: "website", name: "Website", folder: undefined },
    fromHerdr: options.record === false,
    unlinked: address === undefined,
    matched: false,
    checked: state === "checked",
    question: undefined,
    stoppedText: undefined,
  };
}
