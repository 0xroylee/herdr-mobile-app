import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HC_PROTOCOL_GENERATION, REQUIRED_HC_METHODS } from "./index.ts";

interface OpenRpcDocument {
  info: { version: string; description: string };
  methods: { name: string }[];
}

const schema: OpenRpcDocument = JSON.parse(
  readFileSync(new URL("../schema/hc.openrpc.json", import.meta.url), "utf8"),
);

describe("pinned herdr-core schema", () => {
  it("has every method the bridge and app use", () => {
    const methods = new Set(schema.methods.map((method) => method.name));
    expect(REQUIRED_HC_METHODS.filter((name) => !methods.has(name))).toEqual([]);
  });

  it("speaks the protocol generation this client expects", () => {
    expect(schema.info.description).toContain(`Protocol generation ${HC_PROTOCOL_GENERATION}.`);
  });
});
