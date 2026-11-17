/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Status, TaskOutcome, TaskRecord, Terminal } from "@herdr-mobile/protocol";
import {
  classOf,
  desiredOutcome,
  type Mark,
  mark,
  reduce,
  type Tracked,
} from "./task-knowledge.ts";
import {
  buildDeliveries,
  type DeliveryItem,
  generateHistory,
  type History,
  type HistoryShape,
  type OracleResult,
  oracle,
} from "./testing/deliveries.ts";
import { ModelCore, type ModelStep } from "./testing/model-core.ts";

interface Emission {
  address: string;
  kind: Mark["kind"];
  turn: number;
}

interface Fold {
  tracked: Map<string, Tracked>;
  outcomes: Map<string, TaskOutcome | undefined>;
  pending: string[];
  emissions: Emission[];
}

const shapes: HistoryShape[] = ["events", "late-records", "epoch"];

describe("TaskKnowledge generated histories", () => {
  test("deliveries contain only observed facts and have explicit monotonic times", () => {
    const history = scriptedHistory(1, [
      createStep(["codex"]),
      reportStep(50, { state: "working" }),
      reportStep(100, { state: "done" }),
      reportStep(900, { state: "working" }),
      reportStep(1_200, { state: "done" }),
    ]);
    const deliveries = buildDeliveries(history);
    for (const delivery of [deliveries.base, deliveries.equivalent, deliveries.epoch]) {
      expect(delivery.every((item) => "now" in item && Number.isFinite(item.now))).toBe(true);
      expect(delivery.map((item) => String(item.type))).not.toContain("summary-due");
      expect(delivery.map((item) => String(item.type))).not.toContain("summary-read");
      expect(() => assertChronological(delivery)).not.toThrow();
    }
  });

  test("histories catch turn repair and silent snapshot emission regressions", () => {
    const history = {
      ...scriptedHistory(2, [
        createStep(),
        reportStep(50, { state: "working" }),
        reportStep(100, { state: "done" }),
      ]),
      cut: 3,
    };
    const deliveries = buildDeliveries(history);
    const base = fold(deliveries.base, history.addresses);
    const epoch = fold(deliveries.epoch, history.addresses);

    expect(base.emissions).toEqual([{ address: "t1", kind: "done", turn: 1 }]);
    expect(epoch.emissions).toEqual([]);
    assertOutcomes(base, oracle(deliveries.base, history.addresses), "turn repair history");
    assertOutcomes(epoch, oracle(deliveries.epoch, history.addresses), "silent snapshot history");
  });

  for (const shape of shapes) {
    test(`${shape}: 300 seeded histories preserve equivalent deliveries and match the oracle`, () => {
      for (let seed = 1; seed <= 300; seed += 1) {
        const history = generateHistory(seed, shape);
        const deliveries = buildDeliveries(history);
        const base = fold(deliveries.base, history.addresses);
        const equivalent = fold(deliveries.equivalent, history.addresses);
        const epoch = fold(deliveries.epoch, history.addresses);
        const baseOracle = oracle(deliveries.base, history.addresses);
        const equivalentOracle = oracle(deliveries.equivalent, history.addresses);
        const epochOracle = oracle(deliveries.epoch, history.addresses);

        assertJsonEqual(
          [...base.pending].sort(),
          [...equivalent.pending].sort(),
          `${shape} seed ${seed}: equivalent pending reads differ`,
        );
        assertJsonEqual(
          [...baseOracle.summaryKnown].sort(),
          [...equivalentOracle.summaryKnown].sort(),
          `${shape} seed ${seed}: equivalent known summaries differ`,
        );
        assertJsonEqual(
          normalizeOutcomes(base.outcomes, baseOracle.summaryKnown),
          normalizeOutcomes(equivalent.outcomes, equivalentOracle.summaryKnown),
          `${shape} seed ${seed}: equivalent outcomes differ`,
        );
        assertJsonEqual(
          base.emissions,
          equivalent.emissions,
          `${shape} seed ${seed}: equivalent emissions differ`,
        );
        assertJsonEqual(
          base.emissions,
          baseOracle.emissions,
          `${shape} seed ${seed}: base emissions`,
        );
        assertJsonEqual(
          equivalent.emissions,
          equivalentOracle.emissions,
          `${shape} seed ${seed}: equivalent emissions`,
        );
        assertJsonEqual(
          epoch.emissions,
          epochOracle.emissions,
          `${shape} seed ${seed}: epoch emissions`,
        );
        assertOutcomes(base, baseOracle, `${shape} seed ${seed}: base outcome oracle`);
        assertOutcomes(
          equivalent,
          equivalentOracle,
          `${shape} seed ${seed}: equivalent outcome oracle`,
        );
        assertOutcomes(epoch, epochOracle, `${shape} seed ${seed}: epoch outcome oracle`);
      }
    });
  }
});

function fold(delivery: DeliveryItem[], addresses: string[]): Fold {
  const tracked = new Map<string, Tracked>(
    addresses.map((address) => [address, { address, present: false }]),
  );
  const emissions: Emission[] = [];
  let previousNow = Number.NEGATIVE_INFINITY;
  for (const item of delivery) {
    if (item.now < previousNow) {
      throw new Error(`delivery clock moved backwards from ${previousNow} to ${item.now}`);
    }
    previousNow = item.now;
    if (item.type === "snapshot") {
      const found = new Set<string>();
      for (const terminal of item.terminals) {
        if (terminal.address.includes("/")) continue;
        found.add(terminal.address);
        apply(
          tracked,
          emissions,
          terminal.address,
          { type: "seen", terminal, now: item.now },
          "silent",
        );
      }
      for (const [address, value] of tracked) {
        if (value.present && !found.has(address)) {
          apply(tracked, emissions, address, { type: "missing", now: item.now }, "silent");
        }
      }
    } else if (item.type === "event") {
      const address = item.event.terminal;
      if (address === undefined || address.includes("/")) continue;
      if (item.event.type === "created" || item.event.type === "restarted") {
        const terminal = item.revealed ?? (item.event.data as unknown as Terminal);
        apply(tracked, emissions, address, { type: "seen", terminal, now: item.now }, "event");
      } else {
        apply(
          tracked,
          emissions,
          address,
          { type: "event", event: item.event, now: item.now },
          "event",
        );
      }
    } else if (item.type === "record") {
      apply(
        tracked,
        emissions,
        item.address,
        { type: "record", record: item.record, now: item.now },
        "silent",
      );
    }
  }

  const outcomes = new Map<string, TaskOutcome | undefined>();
  const pending: string[] = [];
  for (const address of addresses) {
    const value = tracked.get(address);
    if (value === undefined) continue;
    const result = desiredOutcome(value, 99_999);
    outcomes.set(address, result.outcome);
    if (result.pending) pending.push(address);
  }
  return { tracked, outcomes, pending, emissions };
}

function apply(
  tracked: Map<string, Tracked>,
  emissions: Emission[],
  address: string,
  input: Parameters<typeof reduce>[1],
  source: "event" | "silent",
): void {
  const current = tracked.get(address) ?? { address, present: false };
  const result = mark(reduce(current, input), source);
  tracked.set(address, result.tracked);
  if (result.transition !== undefined && result.tracked.view !== undefined) {
    emissions.push({ address, kind: result.transition.kind, turn: result.transition.turn });
  }
}

function normalizeOutcomes(
  outcomes: Map<string, TaskOutcome | undefined>,
  summaryKnown: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...outcomes.entries()].map(([address, outcome]) => {
      if (outcome === undefined) return [address, undefined];
      const { at: _at, summary, ...rest } = outcome;
      return [
        address,
        { ...rest, ...(summaryKnown.has(address) && summary !== undefined ? { summary } : {}) },
      ];
    }),
  );
}

function assertOutcomes(actual: Fold, expected: OracleResult, message: string): void {
  assertJsonEqual(
    [...actual.pending].sort(),
    [...expected.pending].sort(),
    `${message}: pending reads differ`,
  );

  const actualOutcomes = new Map(actual.outcomes);
  const expectedOutcomes = new Map(expected.outcomes);
  for (const address of expected.pending) {
    const tracked = actual.tracked.get(address);
    const current = tracked === undefined ? undefined : classOf(tracked);
    if (tracked !== undefined && current?.kind === "done") {
      actualOutcomes.set(address, {
        state: "done",
        turn: current.turn,
        ended:
          !tracked.present ||
          tracked.view === undefined ||
          tracked.view.state === "finished" ||
          tracked.view.reason != null,
        at: 0,
      });
    }
    const expectedOutcome = expectedOutcomes.get(address);
    if (expectedOutcome?.state === "done") {
      expectedOutcomes.set(address, {
        state: expectedOutcome.state,
        turn: expectedOutcome.turn,
        ended: expectedOutcome.ended,
        at: 0,
      });
    }
  }

  assertJsonEqual(
    normalizeOutcomes(actualOutcomes, expected.summaryKnown),
    normalizeOutcomes(expectedOutcomes, expected.summaryKnown),
    message,
  );
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}\nactual: ${left}\nexpected: ${right}`);
}

function scriptedHistory(seed: number, steps: ModelStep[]): History {
  const model = new ModelCore();
  for (const step of steps) {
    if (step.kind === "create") model.apply(step);
  }
  const record: TaskRecord = {
    id: "tk00000000000000000000000000000001",
    origin: "phone",
    terminal: "t1",
    createdAt: 0,
  };
  return {
    seed,
    shape: "events",
    addresses: ["t1"],
    steps,
    initial: model.snapshot(),
    linked: [{ address: "t1", record }],
    unlinked: [],
    cut: 1,
    emitNullStatus: false,
  };
}

function createStep(argv = ["agent"]): ModelStep {
  return {
    t: 0,
    address: "t1",
    kind: "create",
    argv,
    cwd: "/work",
    labels: {},
    pid: 10,
  };
}

function reportStep(t: number, status: Status): ModelStep {
  return { t, address: "t1", kind: "report", status };
}

function assertChronological(delivery: DeliveryItem[]): void {
  let previousNow = Number.NEGATIVE_INFINITY;
  for (const item of delivery) {
    if (!("now" in item) || item.now < previousNow) {
      throw new Error("delivery timestamps must be explicit and nondecreasing");
    }
    previousNow = item.now;
  }
}
