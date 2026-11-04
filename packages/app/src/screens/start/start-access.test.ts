/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { getStartScreenAccess } from "./start-access.ts";

describe("Start screen access", () => {
  test("lets connected control devices start agents", () => {
    expect(getStartScreenAccess("control", true)).toEqual({ readOnly: false, canStart: true });
  });

  test("keeps the Start screen read-only on watch devices", () => {
    expect(getStartScreenAccess("watch", true)).toEqual({ readOnly: true, canStart: false });
  });

  test("disables starting while the Mac is disconnected", () => {
    expect(getStartScreenAccess("control", false)).toEqual({ readOnly: false, canStart: false });
    expect(getStartScreenAccess("watch", false)).toEqual({ readOnly: true, canStart: false });
  });
});
