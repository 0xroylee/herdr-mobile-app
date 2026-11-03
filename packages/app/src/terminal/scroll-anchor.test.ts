/// <reference types="bun" />

import { expect, test } from "bun:test";
import { terminalScrollStyle } from "./scroll-anchor.ts";

test("disables browser scroll anchoring on the terminal scroller only on web", () => {
  expect(terminalScrollStyle("web")).toEqual({ overflowAnchor: "none" });
  expect(terminalScrollStyle("ios")).toBeUndefined();
  expect(terminalScrollStyle("android")).toBeUndefined();
});
