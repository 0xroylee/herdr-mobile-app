/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { taskLayout, taskRecord, taskTerminal } from "./tasks.fixtures.ts";
import { deriveTasks, taskState } from "./tasks.ts";

describe("task state", () => {
  test.each([
    ["checked on the same turn", 1, "working", 1, "checked"],
    ["checked when an ended terminal has the same turn", 1, "finished", 1, "checked"],
    ["returns to running on a later turn", 1, "working", 2, "running"],
    ["stays checked when the later turn ends", 1, "finished", 2, "checked"],
  ] as const)("%s", (_label, checkedTurn, terminalState, turn, expected) => {
    const terminal = taskTerminal("t1", {
      state: terminalState,
      reason: terminalState === "finished" ? "exited" : undefined,
      turn,
      status: { state: terminalState === "finished" ? "done" : "working" },
    });
    expect(taskState(taskRecord("1", { checkedTurn }), terminal, terminal.status)).toBe(expected);
  });

  test("keeps a checked task checked when a kept terminal has a reason at a later turn", () => {
    const terminal = taskTerminal("t1", {
      state: "live",
      reason: "signaled",
      turn: 2,
      status: { state: "working" },
    });
    expect(taskState(taskRecord("1", { checkedTurn: 1 }), terminal, terminal.status)).toBe(
      "checked",
    );
  });

  test.each([
    [
      "done status survives a nonzero exit",
      { state: "finished", exit_code: 1 },
      { state: "done" },
      "done",
    ],
    [
      "clean exit after a finished turn is Done",
      { state: "finished", exit_code: 0, turn: 1 },
      null,
      "done",
    ],
    [
      "unclean exit without done evidence is Stopped",
      { state: "finished", exit_code: 1 },
      { state: "working" },
      "stopped",
    ],
    [
      "a kept terminal that lost its process is Stopped",
      { state: "live", reason: "signaled", signal: 9 },
      { state: "working" },
      "stopped",
    ],
    [
      "blocked status needs the user",
      { state: "live" },
      { state: "blocked", msg: "Allow?" },
      "needs-you",
    ],
    ["error status needs the user", { state: "live" }, { state: "error" }, "needs-you"],
    ["working status is Running", { state: "live" }, { state: "working" }, "running"],
    [
      "idle before the first turn is Running",
      { state: "live", turn: 0 },
      { state: "idle" },
      "running",
    ],
    ["idle after a turn is Done", { state: "live", turn: 1 }, { state: "idle" }, "done"],
    ["no status report is Running", { state: "live", status: null }, null, "running"],
  ] as const)("%s", (_label, terminalValues, status, expected) => {
    const terminal =
      terminalValues === undefined
        ? undefined
        : taskTerminal("t1", {
            ...terminalValues,
            status: status === null ? null : status,
          });
    expect(taskState(taskRecord("1"), terminal, status)).toBe(expected);
  });

  test("uses the current live status instead of a conflicting last-seen status", () => {
    const working = taskTerminal("t-working", { status: { state: "working" } });
    const blocked = taskTerminal("t-blocked", { status: { state: "blocked", msg: "Allow?" } });

    expect(taskState(taskRecord("1"), working, { state: "done" })).toBe("running");
    expect(taskState(taskRecord("2"), blocked, { state: "working" })).toBe("needs-you");
  });

  test("uses the phone's last-seen status when the terminal snapshot has no status", () => {
    const terminal = taskTerminal("t1", { state: "finished", status: null, exit_code: 1 });
    expect(taskState(taskRecord("1"), terminal, { state: "done" })).toBe("done");
    expect(taskState(taskRecord("2", { checkedTurn: 1 }), undefined, undefined)).toBe("checked");
  });

  test("a linked record whose terminal is missing is Stopped", () => {
    expect(taskState(taskRecord("1", { terminal: "t-missing" }), undefined, undefined)).toBe(
      "stopped",
    );
  });

  test("formats stopped text from the terminal exit details", () => {
    const rows = deriveTasks(
      {
        code: taskRecord("1", { terminal: "t-code" }),
        signal: taskRecord("2", { terminal: "t-signal" }),
        ended: taskRecord("3", { terminal: "t-ended" }),
      },
      [
        taskTerminal("t-code", { state: "finished", reason: "exited", exit_code: 7 }),
        taskTerminal("t-signal", { state: "live", reason: "signaled", signal: 9 }),
        taskTerminal("t-ended", { state: "finished", reason: "exited", exit_code: null }),
      ],
      undefined,
      {},
      50_000,
    );
    expect(rows.rows.map(({ stoppedText }) => stoppedText)).toEqual([
      "Exited with code 7 before it finished.",
      "Stopped by 9 before it finished.",
      "Ended before it finished.",
    ]);
  });
});

describe("deriveTasks", () => {
  test("includes reported and pending local terminals without records as from Herdr tasks", () => {
    const result = deriveTasks(
      {},
      [
        taskTerminal("t-done", { status: { state: "done" }, title: "Agent tab" }),
        taskTerminal("t-pending", { reported: false, status: null, title: "Starting" }),
        taskTerminal("t-shell", { argv: ["bash"], reported: false, status: null }),
        taskTerminal("t-finished", { state: "finished", reported: false, status: null }),
        taskTerminal("t-finished-reported", { state: "finished", status: { state: "done" } }),
      ],
      undefined,
      {},
      20_000,
    );

    expect(
      result.rows.map(({ id, state, title, fromHerdr }) => ({ id, state, title, fromHerdr })),
    ).toEqual([
      { id: "t:t-done", state: "done", title: "Agent tab", fromHerdr: true },
      { id: "t:t-pending", state: "running", title: "Starting", fromHerdr: true },
    ]);
  });

  test("matches an unlinked program record with the shared window-start rule", () => {
    const record = taskRecord("1", {
      terminal: undefined,
      createdAt: 10_000,
      space: { id: "space-1" },
    });
    const terminals = [
      taskTerminal("wrong-folder", {
        argv: ["bash"],
        reported: false,
        status: null,
        cwd: "/other",
        created_ms: 9_999,
        labels: { "herdr.space": "space-1" },
      }),
      taskTerminal("wrong-space", {
        argv: ["bash"],
        reported: false,
        status: null,
        created_ms: 9_998,
        labels: { "herdr.space": "space-2" },
      }),
      taskTerminal("older", { created_ms: 9_990, labels: { "herdr.space": "space-1" } }),
      taskTerminal("newest", { created_ms: 9_995, labels: { "herdr.space": "space-1" } }),
    ];
    const result = deriveTasks({ [record.id]: record }, terminals, undefined, {}, 50_000);

    expect(result.taskFor(record.id)).toMatchObject({
      address: "newest",
      matched: true,
      state: "running",
    });
  });

  test.each([
    [
      "linked record first",
      [
        taskRecord("older", { terminal: "shared", createdAt: 1_000 }),
        taskRecord("newer", { terminal: undefined, createdAt: 10_000 }),
      ],
    ],
    [
      "unlinked record first",
      [
        taskRecord("newer", { terminal: undefined, createdAt: 10_000 }),
        taskRecord("older", { terminal: "shared", createdAt: 1_000 }),
      ],
    ],
  ] as const)(
    "reserves explicitly linked terminals before matching: %s",
    (_label, orderedRecords) => {
      const result = deriveTasks(
        Object.fromEntries(orderedRecords.map((record) => [record.id, record])),
        [taskTerminal("shared", { created_ms: 9_999 })],
        undefined,
        {},
        50_000,
      );
      const linked = orderedRecords.find((record) => record.terminal !== undefined);
      const unlinked = orderedRecords.find((record) => record.terminal === undefined);

      expect(result.rows).toHaveLength(2);
      expect(result.taskFor(linked?.id ?? "")).toMatchObject({ address: "shared", matched: false });
      expect(result.taskFor(unlinked?.id ?? "")).toMatchObject({
        address: undefined,
        matched: false,
        unlinked: true,
      });
    },
  );

  test("does not match outside the 15 second window or for a template record", () => {
    const tooOld = taskRecord("1", { terminal: undefined, createdAt: 40_000 });
    const template = taskRecord("2", {
      terminal: undefined,
      run: { kind: "template", name: "review" },
      createdAt: 20_000,
    });
    const result = deriveTasks(
      { [tooOld.id]: tooOld, [template.id]: template },
      [
        taskTerminal("too-old", { created_ms: 1 }),
        taskTerminal("template", { created_ms: 19_999 }),
      ],
      undefined,
      {},
      30_000,
    );

    expect(result.taskFor(tooOld.id)).toMatchObject({ address: undefined, matched: false });
    expect(result.taskFor(tooOld.id)).toMatchObject({ unlinked: true, state: "running" });
    expect(result.taskFor(template.id)).toMatchObject({
      address: undefined,
      matched: false,
      unlinked: true,
      state: "running",
    });
  });

  test("keeps a missing record terminal and resolves its fallback project and program", () => {
    const record = taskRecord("1", {
      terminal: "t-missing",
      text: undefined,
      space: { id: "project-record" },
    });
    const result = deriveTasks({ [record.id]: record }, [], taskLayout, {}, 50_000);

    expect(result.rows[0]).toMatchObject({
      address: "t-missing",
      state: "stopped",
      stoppedText: "The terminal is gone.",
      title: "Claude Code",
      project: { id: "project-record", name: "record-folder", folder: "/repo/record-folder" },
    });
  });

  test("uses layout location, then record space, then Herdr label, then Other", () => {
    const located = taskRecord("1", {
      terminal: "t-layout",
      space: { id: "project-record" },
    });
    const recordSpace = taskRecord("2", {
      terminal: undefined,
      space: { id: "project-record" },
    });
    const labeled = taskTerminal("t-labeled", { labels: { "herdr.space": "External" } });
    const other = taskTerminal("t-other");
    const result = deriveTasks(
      { [located.id]: located, [recordSpace.id]: recordSpace },
      [labeled, other],
      taskLayout,
      {},
      50_000,
    );

    expect(result.rows.map(({ id, project }) => [id, project.id, project.name])).toEqual([
      ["t:t-labeled", "External", "External"],
      ["t:t-other", "other", "Other"],
      [located.id, "project-work", "Work"],
      [recordSpace.id, "project-record", "record-folder"],
    ]);
  });

  test.each(["constructor", "__proto__"] as const)(
    "handles a prototype-named Herdr label project id: %s",
    (projectId) => {
      const result = deriveTasks(
        {},
        [taskTerminal("t-labeled", { labels: { "herdr.space": projectId } })],
        undefined,
        {},
        50_000,
      );

      expect(result.rows[0]?.project.id).toBe(projectId);
      expect(result.byProject[projectId]).toHaveLength(1);
      expect(result.counts.projects[projectId]).toEqual({ unchecked: 1, mark: "running" });
    },
  );

  test.each(["constructor", "__proto__"] as const)(
    "handles a prototype-named layout project id: %s",
    (projectId) => {
      const record = taskRecord("project", {
        terminal: undefined,
        folder: undefined,
        run: { kind: "template", name: "review" },
        space: { id: projectId },
      });
      const layout = {
        spaces: [{ id: projectId, name: "Project", folder: null, tabs: [] }],
      };
      const result = deriveTasks({ [record.id]: record }, [], layout, {}, 50_000);

      expect(result.rows[0]?.project.id).toBe(projectId);
      expect(result.byProject[projectId]).toHaveLength(1);
      expect(result.counts.projects[projectId]).toEqual({ unchecked: 1, mark: "running" });
    },
  );

  test("excludes remote terminals and remote-linked records", () => {
    const local = taskTerminal("t-local");
    const remoteRecord = taskRecord("1", { terminal: "box/t7" });
    const result = deriveTasks(
      { [remoteRecord.id]: remoteRecord },
      [local, taskTerminal("box/t7")],
      undefined,
      {},
      50_000,
    );

    expect(result.rows.map(({ id }) => id)).toEqual(["t:t-local"]);
  });

  test("sorts by creation time, then terminal creation time and id", () => {
    const laterRecord = taskRecord("1", { terminal: "t-late", createdAt: 30 });
    const earlierTerminal = taskTerminal("t-second", {
      argv: ["bash"],
      reported: false,
      status: null,
      created_ms: 4,
    });
    const sameTimeRecord = taskRecord("2", { terminal: "t-first", createdAt: 30 });
    const result = deriveTasks(
      { [laterRecord.id]: laterRecord, [sameTimeRecord.id]: sameTimeRecord },
      [
        taskTerminal("t-late", { created_ms: 3 }),
        earlierTerminal,
        taskTerminal("t-first", { created_ms: 2 }),
      ],
      undefined,
      {},
      50_000,
    );

    expect(result.rows.map(({ id }) => id)).toEqual([sameTimeRecord.id, laterRecord.id]);
  });

  test("counts smart lists and marks each project by its most urgent unchecked task", () => {
    const checked = taskRecord("1", { terminal: "t-checked", checkedTurn: 1 });
    const stopped = taskRecord("2", { terminal: "t-stopped" });
    const needsYou = taskRecord("3", { terminal: "t-blocked" });
    const running = taskRecord("4", { terminal: "t-running" });
    const result = deriveTasks(
      Object.fromEntries(
        [checked, stopped, needsYou, running].map((record) => [record.id, record]),
      ),
      [
        taskTerminal("t-checked", { turn: 1 }),
        taskTerminal("t-stopped", { state: "finished", reason: "exited", exit_code: 2 }),
        taskTerminal("t-blocked", { status: { state: "blocked", msg: "Allow?" } }),
        taskTerminal("t-running", { status: { state: "working" } }),
      ],
      undefined,
      {},
      50_000,
    );

    expect(result.counts).toEqual({
      needsYou: 1,
      running: 1,
      done: 1,
      projects: {
        other: { unchecked: 3, mark: "needs-you" },
      },
    });
    expect(result.byProject.other?.map(({ state }) => state)).toEqual([
      "checked",
      "stopped",
      "needs-you",
      "running",
    ]);
    expect(result.taskFor("t:t-blocked")).toBeUndefined();
    expect(result.taskFor(needsYou.id)?.question).toBe("Allow?");
  });

  test("marks done, running and fully checked projects correctly", () => {
    const done = taskRecord("1", { terminal: "t-done", space: { id: "done-project" } });
    const running = taskRecord("2", {
      terminal: "t-running",
      space: { id: "running-project" },
    });
    const checked = taskRecord("3", {
      terminal: "t-checked",
      checkedTurn: 1,
      space: { id: "checked-project" },
    });
    const projectsLayout = {
      spaces: [
        { id: "done-project", name: "Done", folder: null, tabs: [] },
        { id: "running-project", name: "Running", folder: null, tabs: [] },
        { id: "checked-project", name: "Checked", folder: null, tabs: [] },
      ],
    };
    const result = deriveTasks(
      Object.fromEntries([done, running, checked].map((record) => [record.id, record])),
      [
        taskTerminal("t-done", { status: { state: "done" } }),
        taskTerminal("t-running", { status: { state: "working" } }),
        taskTerminal("t-checked", { turn: 1 }),
      ],
      projectsLayout,
      {},
      50_000,
    );

    expect(result.counts.projects).toEqual({
      "done-project": { unchecked: 1, mark: "done" },
      "running-project": { unchecked: 1, mark: "running" },
      "checked-project": { unchecked: 0, mark: undefined },
    });
  });

  test("keeps the from-Herdr tab title when a task is checked off and unchecked", () => {
    const terminal = taskTerminal("t-layout", { title: "Terminal title" });
    const record = taskRecord("adopted", {
      terminal: "t-layout",
      text: undefined,
      checkedTurn: 1,
    });
    const uncheckedRecord = taskRecord("adopted", {
      terminal: "t-layout",
      text: undefined,
    });
    const before = deriveTasks({}, [terminal], taskLayout, {}, 50_000);
    const checked = deriveTasks({ [record.id]: record }, [terminal], taskLayout, {}, 50_000);
    const unchecked = deriveTasks(
      { [uncheckedRecord.id]: uncheckedRecord },
      [terminal],
      taskLayout,
      {},
      50_000,
    );

    expect([before.rows[0]?.title, checked.rows[0]?.title, unchecked.rows[0]?.title]).toEqual([
      "Work tab",
      "Work tab",
      "Work tab",
    ]);
  });

  test("uses the herdr.tab title fallback when no layout is available", () => {
    const terminal = taskTerminal("t-label-tab", { labels: { "herdr.tab": "Label tab" } });
    const record = taskRecord("label-tab", { terminal: "t-label-tab", text: undefined });
    const fromHerdr = deriveTasks({}, [terminal], undefined, {}, 50_000);
    const withRecord = deriveTasks({ [record.id]: record }, [terminal], undefined, {}, 50_000);

    expect(fromHerdr.rows[0]?.title).toBe("Label tab");
    expect(withRecord.rows[0]?.title).toBe("Label tab");
  });

  test("uses stable row title, terminal metadata and the project folder basename", () => {
    const record = taskRecord("1", { terminal: "t-layout" });
    const result = deriveTasks(
      { [record.id]: record },
      [taskTerminal("t-layout", { status: { state: "blocked", title: "Question" } })],
      taskLayout,
      {},
      50_000,
    );

    expect(result.rows[0]).toMatchObject({
      title: "Review the task",
      program: { name: "Claude Code", iconKey: "claude" },
      project: { id: "project-work", name: "Work", folder: "/repo/work" },
      question: "Question",
    });
  });

  test("uses status message before title for the task question", () => {
    const record = taskRecord("1", { terminal: "t1" });
    const result = deriveTasks(
      { [record.id]: record },
      [taskTerminal("t1", { status: { state: "error", msg: "Allow this?", title: "Permission" } })],
      undefined,
      {},
      50_000,
    );
    expect(result.rows[0]?.question).toBe("Allow this?");
  });
});
