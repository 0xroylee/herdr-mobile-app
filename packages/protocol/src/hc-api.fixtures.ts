// Type fixtures for the generated hc API, checked by `bun run typecheck` and never imported.
// Each @ts-expect-error line must stay an error; if the generated types loosen, typecheck fails.

import type { HcMethodMap, HcParams, HcResult } from "./generated/hc-api.ts";
import type { REQUIRED_HC_METHODS } from "./index.ts";

export const attach: HcParams<"terminal.attach"> = {
  terminal: "t1",
  cols: 80,
  rows: 24,
  observe: true,
};
export const keys: HcParams<"terminal.keys"> = { terminal: "t1", keys: ["esc", "ctrl+c"] };
export const send: HcParams<"terminal.send"> = { terminal: "t1", text: "hi", if: "idle" };
export const subscribe: HcParams<"events.subscribe"> = { labels: { "herdr.space": "sp1" } };
export const stop: HcParams<"server.stop"> = {};
export const exitedNull: Pick<HcResult<"terminal.get">, "exit_code" | "status"> = {
  exit_code: null,
  status: null,
};
export const cell: HcParams<"terminal.attach">["display"] = { cell: [8, 16], bg: null };

// @ts-expect-error terminal is required
export const missingTerminal: HcParams<"terminal.attach"> = { cols: 80, rows: 24 };
// @ts-expect-error cols is a number
export const textCols: HcParams<"terminal.attach"> = { terminal: "t1", cols: "80", rows: 24 };
// @ts-expect-error if only accepts idle or working
export const busy: HcParams<"terminal.send"> = { terminal: "t1", text: "hi", if: "busy" };
// @ts-expect-error status is a Status or null, never a number
export const numericStatus: Pick<HcResult<"terminal.get">, "status"> = { status: 3 };
// @ts-expect-error cell is a pair
export const tripleCell: HcParams<"terminal.attach">["display"] = { cell: [8, 16, 1] };
// @ts-expect-error server.stop takes no params
export const stopWithParams: HcParams<"server.stop"> = { force: true };

/** Every required method has an entry in the generated map. */
export const covered: (typeof REQUIRED_HC_METHODS)[number] extends keyof HcMethodMap
  ? true
  : never = true;
