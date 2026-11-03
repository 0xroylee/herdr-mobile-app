/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { HcEvent, Layout, Terminal } from "@herdr-mobile/protocol";
import { deriveAgents } from "./agents.ts";
import { applyEvent, applySnapshot } from "./terminals.ts";

const terminal = (
  address: string,
  state: string,
  statusMs: number,
  extra: Partial<Terminal> = {},
): Terminal => ({
  address,
  argv: ["claude"],
  cols: 80,
  created_ms: 1,
  cwd: "/repo",
  labels: {},
  reported: true,
  rows: 24,
  screen: "exact",
  state: "live",
  status: { state },
  status_ms: statusMs,
  turn: 1,
  ...extra,
});

const statusEvent = (status: unknown): HcEvent => ({
  seq: 2,
  type: "status",
  terminal: "t1",
  data: { status, records: {}, reported: true } as HcEvent["data"],
});

const layout: Layout = {
  spaces: [
    {
      id: "work",
      name: "Work",
      folder: null,
      tabs: [
        { id: "first", name: "First tab", terminalAddresses: ["t2", "t1"] },
        { id: "second", name: "Second tab", terminalAddresses: ["t3"] },
      ],
    },
    {
      id: "home",
      name: "Home",
      folder: null,
      tabs: [{ id: "home-tab", name: "Home tab", terminalAddresses: ["t4"] }],
    },
  ],
};

describe("deriveAgents", () => {
  test("orders reported agents by priority and excludes unrelated unreported terminals", () => {
    const rows = deriveAgents(
      [
        terminal("done-old", "done", 10),
        terminal("working", "working", 20),
        terminal("blocked-old", "error", 5),
        terminal("blocked-new", "blocked", 30, { status: { state: "blocked", msg: "Allow?" } }),
        terminal("idle", "unknown", 40),
        terminal("unreported", "", 50, { argv: ["bash"], reported: false, status: null }),
      ],
      undefined,
      {},
      "machine-id",
      100_000,
      "priority",
      undefined,
    );
    expect(rows.map(({ label }) => label)).toEqual(["Needs you", "Done", "Working", "Idle"]);
    expect(rows[0]?.agents.map(({ address }) => address)).toEqual(["blocked-new", "blocked-old"]);
    expect(rows[0]?.agents[0]?.question).toBe("Allow?");
    expect(rows[1]?.agents[0]?.address).toBe("done-old");
    expect(rows[3]?.agents.map(({ address }) => address)).toEqual(["idle"]);
  });

  test("lists live unreported Claude Code and Codex terminals as pending Idle rows", () => {
    const claudeArgv = terminal("claude-argv", "", 10, {
      argv: ["claude"],
      reported: false,
      status: null,
    });
    const claudeForeground = terminal("claude-foreground", "", 11, {
      argv: ["zsh"],
      foreground: { argv: ["claude"], cwd: "/repo", name: "claude", pid: 101 },
      reported: false,
      status: null,
    });
    const codexArgv = terminal("codex-argv", "", 12, {
      argv: ["codex"],
      reported: false,
      status: null,
    });
    const codexForeground = terminal("codex-foreground", "", 13, {
      argv: ["zsh"],
      foreground: { argv: ["codex"], cwd: "/repo", name: "codex", pid: 102 },
      reported: false,
      status: null,
    });

    const rows = deriveAgents(
      [claudeArgv, claudeForeground, codexArgv, codexForeground],
      undefined,
      {},
      "machine-id",
      20,
      "priority",
      undefined,
    );

    expect(rows.map(({ label }) => label)).toEqual(["Idle"]);
    expect(
      rows[0]?.agents.map(({ address, program, state, pending, question }) => ({
        address,
        program: program.name,
        state,
        pending,
        question,
      })),
    ).toEqual([
      {
        address: "codex-foreground",
        program: "Codex",
        state: "idle",
        pending: true,
        question: undefined,
      },
      {
        address: "codex-argv",
        program: "Codex",
        state: "idle",
        pending: true,
        question: undefined,
      },
      {
        address: "claude-foreground",
        program: "Claude Code",
        state: "idle",
        pending: true,
        question: undefined,
      },
      {
        address: "claude-argv",
        program: "Claude Code",
        state: "idle",
        pending: true,
        question: undefined,
      },
    ]);
  });

  test("lists live unreported template terminals as pending", () => {
    const result = deriveAgents(
      [
        terminal("template", "", 1, {
          argv: ["bash"],
          reported: false,
          status: null,
          template: "ask",
        }),
      ],
      undefined,
      {},
      "machine-id",
      2,
      "priority",
      undefined,
    );

    expect(result[0]?.agents[0]).toMatchObject({
      state: "idle",
      pending: true,
      question: undefined,
    });
  });

  test("does not list finished unreported Claude Code terminals as pending", () => {
    const result = deriveAgents(
      [terminal("finished", "", 1, { state: "finished", reported: false, status: null })],
      undefined,
      {},
      "machine-id",
      2,
      "priority",
      undefined,
    );

    expect(result).toEqual([]);
  });

  test("does not list live unreported shell terminals without a template", () => {
    const result = deriveAgents(
      [terminal("shell", "", 1, { argv: ["bash"], reported: false, status: null })],
      undefined,
      {},
      "machine-id",
      2,
      "priority",
      undefined,
    );

    expect(result).toEqual([]);
  });

  test("clears pending when a terminal reports working", () => {
    const pending = terminal("t1", "", 1, { reported: false, status: null });
    const reported = { ...pending, reported: true, status: { state: "working" } };
    const result = deriveAgents([reported], undefined, {}, "machine-id", 2, "priority", undefined);

    expect(result.map(({ label }) => label)).toEqual(["Working"]);
    expect(result[0]?.agents[0]).toMatchObject({ state: "working", pending: false });
  });

  test("includes pending rows in search and their space group", () => {
    const pending = terminal("t2", "", 1, { reported: false, status: null });
    const searched = deriveAgents(
      [pending],
      undefined,
      {},
      "machine-id",
      2,
      "priority",
      "Claude Code",
    );
    const grouped = deriveAgents([pending], layout, {}, "machine-id", 2, "space", undefined);

    expect(searched[0]?.agents[0]).toMatchObject({ address: "t2", pending: true });
    expect(grouped.map(({ label }) => label)).toEqual(["Work"]);
    expect(grouped[0]?.agents[0]).toMatchObject({ address: "t2", pending: true });
  });

  test("a seen done turn becomes idle and a higher turn returns it to Done", () => {
    const done = terminal("t1", "done", 10);
    const seen = { "seen.machine-id.t1": 1 };
    const result = (current: Terminal) =>
      deriveAgents([current], undefined, seen, "machine-id", 20_000, "priority", undefined);
    expect(result(done).map(({ label }) => label)).toEqual(["Idle"]);
    expect(result({ ...done, turn: 2 }).map(({ label }) => label)).toEqual(["Done"]);
  });

  test("seen turns are scoped to the active paired machine", () => {
    const done = terminal("t7", "done", 10, { turn: 3 });
    const seen = { "seen.mac-a.t7": 3 };
    const result = (machineId: string) =>
      deriveAgents([done], undefined, seen, machineId, 20_000, "priority", undefined);
    expect(result("mac-a").map(({ label }) => label)).toEqual(["Idle"]);
    expect(result("mac-b").map(({ label }) => label)).toEqual(["Done"]);
  });

  test("uses tab title, live title, name and program as ordered title fallbacks", () => {
    const withLayout = deriveAgents(
      [terminal("t1", "working", 1, { title: "Live title" })],
      layout,
      {},
      "machine-id",
      2,
      "priority",
      undefined,
    );
    expect(withLayout[0]?.agents[0]?.title).toBe("First tab");
    const withTab = deriveAgents(
      [terminal("t2", "working", 1)],
      layout,
      {},
      "machine-id",
      2,
      "priority",
      undefined,
    );
    expect(withTab[0]?.agents[0]?.title).toBe("First tab");
    const noTitle = terminal("t9", "working", 1, { name: "Terminal name" });
    expect(
      deriveAgents([noTitle], undefined, {}, "machine-id", 2, "priority", undefined)[0]?.agents[0]
        ?.title,
    ).toBe("Terminal name");
    const programTitle = terminal("t8", "working", 1, { argv: ["codex"] });
    expect(
      deriveAgents([programTitle], undefined, {}, "machine-id", 2, "priority", undefined)[0]
        ?.agents[0]?.title,
    ).toBe("Codex");
  });

  test("space sort follows document spaces, tab address order, then puts unmatched terminals in Other", () => {
    const result = deriveAgents(
      [
        terminal("t1", "working", 1),
        terminal("unmapped", "blocked", 2),
        terminal("t4", "done", 3),
        terminal("t2", "idle", 4),
      ],
      layout,
      {},
      "machine-id",
      5,
      "space",
      undefined,
    );
    expect(result.map(({ label }) => label)).toEqual(["Work", "Home", "Other"]);
    expect(result[0]?.agents.map(({ address }) => address)).toEqual(["t2", "t1"]);
    expect(result[2]?.agents[0]?.address).toBe("unmapped");
  });

  test("uses space and tab labels when the layout document is missing", () => {
    const result = deriveAgents(
      [
        terminal("t1", "working", 1, { labels: { "herdr.space": "Docs", "herdr.tab": "Nav" } }),
        terminal("t2", "idle", 2),
      ],
      undefined,
      {},
      "machine-id",
      3,
      "space",
      undefined,
    );
    expect(result.map(({ label }) => label)).toEqual(["Docs", "Other"]);
    expect(result[0]?.agents[0]).toMatchObject({ title: "Nav", subtitle: "Claude Code" });
  });

  test("applies case-insensitive search to title, subtitle, address and question", () => {
    const result = deriveAgents(
      [terminal("t1", "blocked", 1, { status: { state: "blocked", msg: "Allow database?" } })],
      undefined,
      {},
      "machine-id",
      2,
      "priority",
      "DATABASE",
    );
    expect(result[0]?.agents).toHaveLength(1);
    expect(
      deriveAgents(
        [terminal("t1", "blocked", 1)],
        undefined,
        {},
        "machine-id",
        2,
        "priority",
        "missing",
      ),
    ).toEqual([]);
  });

  test("derives subtitles for priority and by-space rows", () => {
    const blocked = terminal("t1", "blocked", 10, {
      status: { state: "blocked", msg: "Allow?" },
    });
    const working = terminal("t2", "working", 20);
    const priority = deriveAgents(
      [blocked, working],
      layout,
      {},
      "machine-id",
      30,
      "priority",
      undefined,
    );
    expect(priority.find(({ state }) => state === "blocked")?.agents[0]?.subtitle).toBe(
      "Work · Claude Code",
    );
    expect(priority.find(({ state }) => state === "working")?.agents[0]?.subtitle).toBe(
      "Work · Claude Code",
    );

    const bySpace = deriveAgents(
      [blocked, working],
      layout,
      {},
      "machine-id",
      30,
      "space",
      undefined,
    );
    expect(bySpace[0]?.agents.map(({ address, subtitle }) => [address, subtitle])).toEqual([
      ["t2", "Claude Code"],
      ["t1", "Claude Code · Allow?"],
    ]);
  });

  test("status changes refresh list order and age, while same-state reports keep the time", () => {
    const snapshot = applySnapshot({
      seq: 1,
      terminals: [
        terminal("t1", "working", 1_000),
        terminal("t2", "blocked", 100_000, { status: { state: "blocked" } }),
      ],
    });
    const changed = applyEvent(snapshot, statusEvent({ state: "blocked" }), 120_000);
    const rows = deriveAgents(changed, undefined, {}, "machine-id", 220_000, "priority", undefined);
    expect(rows[0]?.agents.map(({ address, age }) => [address, age])).toEqual([
      ["t1", "1m"],
      ["t2", "2m"],
    ]);

    const repeated = applyEvent(
      changed,
      statusEvent({ state: "blocked", msg: "Still here?" }),
      230_000,
    );
    expect(repeated.t1?.status_ms).toBe(120_000);
  });
});
