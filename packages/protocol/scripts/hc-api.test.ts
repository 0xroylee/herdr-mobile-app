import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REQUIRED_HC_METHODS } from "../src/index.ts";
import {
  generateHcApi,
  missingRequiredMethods,
  type OpenRpcDocument,
  PROJECTED_METHODS,
} from "./hc-api.ts";

const sample: OpenRpcDocument = {
  info: { version: "9.9.9" },
  methods: [
    {
      name: "demo.call",
      summary: "A demo call.",
      params: [
        { name: "id", required: true, schema: { type: "string" } },
        { name: "limit", required: false, schema: { type: ["integer", "null"] } },
        { name: "mode", schema: { $ref: "#/components/schemas/Mode" } },
      ],
      result: { schema: { $ref: "#/components/schemas/Out" } },
    },
    { name: "demo.empty", params: [], result: { schema: { type: "boolean" } } },
    { name: "demo.unused", result: { schema: { $ref: "#/components/schemas/Unused" } } },
  ],
  components: {
    schemas: {
      Out: {
        type: "object",
        description: "Result of a demo call.",
        required: ["tags", "value"],
        properties: {
          tags: { type: "array", items: { type: "string" } },
          cell: { type: ["array", "null"], items: { type: "integer" }, minItems: 2, maxItems: 2 },
          inner: { $ref: "#/components/schemas/Inner" },
          maybe: { anyOf: [{ $ref: "#/components/schemas/Mode" }, { type: "null" }] },
          labels: { type: "object", additionalProperties: { type: "string" } },
          value: true,
          either: { type: "array", items: { type: ["string", "integer"] } },
        },
      },
      Inner: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
      Mode: { type: "string", enum: ["idle", "working"] },
      Unused: { type: "object", properties: { x: { type: "string" } } },
    },
  },
};

function load(): { doc: OpenRpcDocument; committed: string } {
  const root = new URL("../", import.meta.url);
  return {
    doc: JSON.parse(readFileSync(new URL("schema/hc.openrpc.json", root), "utf8")),
    committed: readFileSync(new URL("src/generated/hc-api.ts", root), "utf8"),
  };
}

describe("generateHcApi", () => {
  const { source, methods } = generateHcApi(sample, ["demo.call", "demo.empty"]);

  test("keeps required, optional and nullable params", () => {
    expect(source).toContain(
      "export interface DemoCallParams {\n  id: string;\n  limit?: number | null;\n  mode?: Mode;\n}",
    );
  });

  test("maps arrays, tuples, references, nullable unions, maps and opaque JSON", () => {
    expect(source).toContain("  tags: string[];");
    expect(source).toContain("  cell?: [number, number] | null;");
    expect(source).toContain("  inner?: Inner;");
    expect(source).toContain("  maybe?: Mode | null;");
    expect(source).toContain("  labels?: { [key: string]: string };");
    expect(source).toContain("  value: JsonValue;");
    expect(source).toContain("  either?: (string | number)[];");
    expect(source).toContain('import type { JsonValue } from "../wire.ts";');
  });

  test("turns string enums into literal unions", () => {
    expect(source).toContain('export type Mode = "idle" | "working";');
  });

  test("emits only reachable components, sorted, with descriptions", () => {
    expect(source).not.toContain("Unused");
    const order = [
      "export interface Inner",
      "export type Mode",
      "/** Result of a demo call. */\nexport interface Out",
    ];
    const positions = order.map((marker) => source.indexOf(marker));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("describes a method without params as an empty record", () => {
    expect(source).toContain("export type DemoEmptyParams = Record<string, never>;");
    expect(source).toContain('  "demo.call": { params: DemoCallParams; result: Out };');
    expect(source).toContain('  "demo.empty": { params: DemoEmptyParams; result: boolean };');
    expect(methods).toEqual(["demo.call", "demo.empty"]);
  });

  test("is deterministic", () => {
    expect(generateHcApi(sample, ["demo.call", "demo.empty"]).source).toBe(source);
  });

  test("refuses a method the schema lacks", () => {
    expect(() => generateHcApi(sample, ["demo.missing"])).toThrow(
      "Unknown hc method in schema: demo.missing",
    );
  });
});

describe("the pinned hc API", () => {
  test("projects every required method plus server.stop", () => {
    const { doc } = load();
    expect(generateHcApi(doc, PROJECTED_METHODS).methods).toEqual([
      ...REQUIRED_HC_METHODS,
      "server.stop",
    ]);
  });

  test("names each required method a generated map lacks", () => {
    expect(missingRequiredMethods(["hello"], ["hello", "terminal.keys"])).toEqual([
      "Missing required hc method: terminal.keys",
    ]);
    expect(missingRequiredMethods(PROJECTED_METHODS, REQUIRED_HC_METHODS)).toEqual([]);
  });

  test("committed types match the pinned schema", () => {
    const { doc, committed } = load();
    expect(committed).toBe(generateHcApi(doc, PROJECTED_METHODS).source);
  });
});
