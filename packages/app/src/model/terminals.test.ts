/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { HcEvent, Terminal } from "@herdr-mobile/protocol";
import { applyEvent, applySnapshot } from "./terminals.ts";

const baseTerminal = (address = "t1"): Terminal => ({
  address,
  argv: ["claude"],
  cols: 120,
  created_ms: 1,
  cwd: "/repo",
  foreground: { pid: 42, name: "claude", argv: ["claude"], cwd: "/repo" },
  labels: {},
  pid: 42,
  records: {},
  reported: false,
  rows: 36,
  screen: "exact",
  state: "live",
  status: { state: "working" },
  status_ms: 10,
  turn: 1,
});

const event = (type: string, data: unknown, terminal: string | undefined = "t1"): HcEvent => ({
  seq: 1,
  type,
  terminal,
  data: data as HcEvent["data"],
});

describe("terminal reducer", () => {
  test("snapshot replaces the table and keys records by address", () => {
    expect(applySnapshot({ seq: 4, terminals: [baseTerminal(), baseTerminal("box/t2")] })).toEqual({
      t1: baseTerminal(),
      "box/t2": baseTerminal("box/t2"),
    });
  });

  test("created adds and restarted replaces the full terminal", () => {
    const initial = { t1: baseTerminal() };
    const created = baseTerminal("t2");
    const afterCreate = applyEvent(initial, event("created", created, "t2"), 100);
    expect(afterCreate.t2).toEqual(created);

    const restarted = { ...baseTerminal("t1"), cwd: "/new-shell", turn: 3 };
    expect(applyEvent(initial, event("restarted", restarted), 100)).toEqual({ t1: restarted });
    expect(initial.t1?.cwd).toBe("/repo");
  });

  test("lost keeps the terminal live, clears its process and drops foreground", () => {
    const result = applyEvent(
      { t1: baseTerminal() },
      event("lost", {
        reason: "signaled",
        exit_code: null,
        signal: 9,
        finished_ms: null,
      }),
      100,
    );
    expect(result.t1).toMatchObject({ state: "live", reason: "signaled", pid: null, signal: 9 });
    expect(result.t1?.finished_ms).toBeNull();
    expect(result.t1).not.toHaveProperty("foreground");
  });

  test("keep updates the keep flag", () => {
    expect(applyEvent({ t1: baseTerminal() }, event("keep", { keep: true }), 100).t1?.keep).toBe(
      true,
    );
  });

  test("finished changes state and drops foreground", () => {
    const result = applyEvent(
      { t1: baseTerminal() },
      event("finished", {
        reason: "exited",
        exit_code: 0,
        signal: null,
        finished_ms: 200,
      }),
      100,
    );
    expect(result.t1).toMatchObject({
      state: "finished",
      reason: "exited",
      exit_code: 0,
      finished_ms: 200,
    });
    expect(result.t1).not.toHaveProperty("foreground");
  });

  test("removed drops the terminal", () => {
    expect(applyEvent({ t1: baseTerminal() }, event("removed", {}), 100)).toEqual({});
  });

  test("status replaces the root status, records and reported flag", () => {
    const result = applyEvent(
      { t1: baseTerminal() },
      event("status", {
        status: { state: "blocked", kind: "permission", msg: "Allow?" },
        records: { child: { state: "working" } },
        reported: true,
      }),
      100,
    );
    expect(result.t1).toMatchObject({
      status: { state: "blocked", kind: "permission", msg: "Allow?" },
      status_ms: 100,
      records: { child: { state: "working" } },
      reported: true,
    });
    const cleared = applyEvent(
      result,
      event("status", { status: null, records: {}, reported: true }),
      200,
    );
    expect(cleared.t1?.status).toBeNull();
    expect(cleared.t1?.status_ms).toBe(200);
  });

  test("turn changes the counter but leaves other terminal facts intact", () => {
    expect(
      applyEvent({ t1: baseTerminal() }, event("turn", { turn: 2, state: "done" }), 100).t1,
    ).toMatchObject({
      turn: 2,
      status: { state: "working" },
    });
  });

  test("title and size replace their fields", () => {
    const withTitle = applyEvent({ t1: baseTerminal() }, event("title", { title: "Docs" }), 100);
    const withSize = applyEvent(withTitle, event("size", { cols: 80, rows: 24 }), 100);
    expect(withSize.t1).toMatchObject({ title: "Docs", cols: 80, rows: 24 });
  });

  test("labels replace values and a newly matching record is added", () => {
    const updated = applyEvent(
      { t1: baseTerminal() },
      event("labels", { labels: { "herdr.space": "Docs" } }),
      100,
    );
    expect(updated.t1?.labels).toEqual({ "herdr.space": "Docs" });
    const record = baseTerminal("t2");
    expect(
      applyEvent(updated, event("labels", { labels: record.labels, record }, "t2"), 100).t2,
    ).toEqual(record);
  });

  test("foreground replaces the process and null clears it", () => {
    const foreground = { pid: 7, name: "node", argv: ["node", "serve.js"], cwd: "/repo" };
    const updated = applyEvent({ t1: baseTerminal() }, event("foreground", foreground), 100);
    expect(updated.t1?.foreground).toEqual(foreground);
    expect(applyEvent(updated, event("foreground", null), 100).t1?.foreground).toBeNull();
  });

  test("missed replaces the snapshot and doc events do not alter terminals", () => {
    const current = { t1: baseTerminal() };
    const afterMissed = applyEvent(
      current,
      event("missed", { terminals: [baseTerminal("t2")] }),
      100,
    );
    expect(afterMissed).toEqual({ t2: baseTerminal("t2") });
    expect(
      applyEvent(afterMissed, event("doc", { name: "herdr-app", version: 2 }, undefined), 100),
    ).toEqual(afterMissed);
  });
});
