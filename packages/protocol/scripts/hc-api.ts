// Generates TypeScript types for the hc methods this project uses, from the pinned OpenRPC
// schema. `--write` refreshes src/generated/hc-api.ts; `--check` fails when a required method is
// missing or the file is stale. Build-time only: nothing under src imports this file.

import { REQUIRED_HC_METHODS } from "../src/index.ts";

type Schema = boolean | { [key: string]: unknown };

interface OpenRpcParam {
  name: string;
  required?: boolean;
  description?: string;
  schema: Schema;
}

interface OpenRpcMethod {
  name: string;
  summary?: string;
  description?: string;
  params?: OpenRpcParam[];
  result?: { schema: Schema };
}

export interface OpenRpcDocument {
  info: { version: string };
  methods: OpenRpcMethod[];
  components?: { schemas?: Record<string, Schema> };
}

export interface GeneratedApi {
  source: string;
  methods: string[];
}

/** The required methods, plus server.stop for shutting down the prototype's scratch core. */
export const PROJECTED_METHODS: readonly string[] = [...REQUIRED_HC_METHODS, "server.stop"];

const MAX_TUPLE = 8;

function pascal(name: string): string {
  return name
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function docComment(text: string | undefined, indent: string): string {
  if (!text) return "";
  const lines = text.replaceAll("*/", "*\\/").trim().split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

function union(types: string[]): string {
  return [...new Set(types)].join(" | ");
}

function asElement(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

class Renderer {
  readonly refs = new Set<string>();
  usesJson = false;
  private readonly components: Record<string, Schema>;

  constructor(components: Record<string, Schema>) {
    this.components = components;
  }

  json(): string {
    this.usesJson = true;
    return "JsonValue";
  }

  type(schema: Schema, indent: string): string {
    if (schema === true) return this.json();
    if (schema === false) return "never";
    const ref = schema.$ref;
    if (typeof ref === "string") {
      const name = ref.split("/").pop() as string;
      if (!(name in this.components)) throw new Error(`Unknown schema reference: ${ref}`);
      this.refs.add(name);
      return name;
    }
    if (Array.isArray(schema.anyOf)) {
      return union((schema.anyOf as Schema[]).map((alt) => this.type(alt, indent)));
    }
    if (Array.isArray(schema.enum)) {
      return union((schema.enum as unknown[]).map((value) => JSON.stringify(value)));
    }
    const declared = schema.type;
    if (Array.isArray(declared)) {
      return union((declared as string[]).map((one) => this.single(one, schema, indent)));
    }
    if (typeof declared === "string") return this.single(declared, schema, indent);
    if (schema.properties !== undefined || schema.additionalProperties !== undefined) {
      return this.object(schema, indent);
    }
    return this.json();
  }

  private single(declared: string, schema: { [key: string]: unknown }, indent: string): string {
    switch (declared) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const items = schema.items as Schema | undefined;
        const element = items === undefined ? this.json() : this.type(items, indent);
        const { minItems, maxItems } = schema;
        if (
          typeof minItems === "number" &&
          minItems === maxItems &&
          minItems > 0 &&
          minItems <= MAX_TUPLE
        ) {
          return `[${Array.from({ length: minItems }, () => element).join(", ")}]`;
        }
        return `${asElement(element)}[]`;
      }
      case "object":
        return this.object(schema, indent);
      default:
        throw new Error(`Unsupported schema type: ${declared}`);
    }
  }

  object(schema: { [key: string]: unknown }, indent: string): string {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set((schema.required ?? []) as string[]);
    const extra = schema.additionalProperties as Schema | undefined;
    const names = Object.keys(properties);
    if (names.length === 0) {
      const value = extra === undefined || extra === true ? this.json() : this.type(extra, indent);
      return `{ [key: string]: ${value} }`;
    }
    const inner = `${indent}  `;
    const fields = names.map((name) => {
      const property = properties[name] as Schema;
      const description =
        typeof property === "object" ? (property.description as string | undefined) : undefined;
      const optional = required.has(name) ? "" : "?";
      return `${docComment(description, inner)}${inner}${name}${optional}: ${this.type(property, inner)};`;
    });
    return `{\n${fields.join("\n")}\n${indent}}`;
  }
}

export function generateHcApi(doc: OpenRpcDocument, methodNames: readonly string[]): GeneratedApi {
  const components = doc.components?.schemas ?? {};
  const byName = new Map(doc.methods.map((method) => [method.name, method]));
  const renderer = new Renderer(components);
  const paramDecls: string[] = [];
  const mapEntries: string[] = [];

  for (const name of methodNames) {
    const method = byName.get(name);
    if (!method) throw new Error(`Unknown hc method in schema: ${name}`);
    const paramsName = `${pascal(name)}Params`;
    const summary = method.summary ?? method.description;
    const params = method.params ?? [];
    if (params.length === 0) {
      paramDecls.push(
        `${docComment(summary, "")}export type ${paramsName} = Record<string, never>;`,
      );
    } else {
      const fields = params.map((param) => {
        const description =
          param.description ??
          (typeof param.schema === "object"
            ? (param.schema.description as string | undefined)
            : undefined);
        const optional = param.required ? "" : "?";
        return `${docComment(description, "  ")}  ${param.name}${optional}: ${renderer.type(param.schema, "  ")};`;
      });
      paramDecls.push(
        `${docComment(summary, "")}export interface ${paramsName} {\n${fields.join("\n")}\n}`,
      );
    }
    const result = method.result ? renderer.type(method.result.schema, "  ") : "null";
    mapEntries.push(`  ${JSON.stringify(name)}: { params: ${paramsName}; result: ${result} };`);
  }

  // Components reachable from the projected methods, following references transitively.
  const componentDecls = new Map<string, string>();
  const pending = [...renderer.refs];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (componentDecls.has(name)) continue;
    const schema = components[name] as Schema;
    const before = new Set(renderer.refs);
    const description =
      typeof schema === "object" ? (schema.description as string | undefined) : undefined;
    const isObject = typeof schema === "object" && schema.properties !== undefined;
    const body = isObject
      ? `export interface ${name} ${renderer.object(schema as { [key: string]: unknown }, "")}`
      : `export type ${name} = ${renderer.type(schema, "")};`;
    componentDecls.set(name, `${docComment(description, "")}${body}`);
    for (const ref of renderer.refs) if (!before.has(ref)) pending.push(ref);
  }

  const header = [
    `// Generated by packages/protocol/scripts/hc-api.ts from schema/hc.openrpc.json (hc ${doc.info.version}).`,
    "// Do not edit by hand: run `bun run protocol:generate`.",
    "",
  ];
  if (renderer.usesJson) header.push('import type { JsonValue } from "../wire.ts";', "");
  const sortedComponents = [...componentDecls.keys()]
    .sort()
    .map((name) => componentDecls.get(name));
  const source = [
    ...header,
    ...sortedComponents.flatMap((decl) => [decl, ""]),
    ...paramDecls.flatMap((decl) => [decl, ""]),
    "export interface HcMethodMap {",
    ...mapEntries,
    "}",
    "",
    "export type HcMethod = keyof HcMethodMap;",
    'export type HcParams<M extends HcMethod> = HcMethodMap[M]["params"];',
    'export type HcResult<M extends HcMethod> = HcMethodMap[M]["result"];',
    "",
  ].join("\n");
  return { source, methods: [...methodNames] };
}

/** One message per required method the generated map lacks. */
export function missingRequiredMethods(
  generated: readonly string[],
  required: readonly string[],
): string[] {
  return required
    .filter((method) => !generated.includes(method))
    .map((method) => `Missing required hc method: ${method}`);
}

async function main(mode: string | undefined): Promise<number> {
  const schemaUrl = new URL("../schema/hc.openrpc.json", import.meta.url);
  const outputUrl = new URL("../src/generated/hc-api.ts", import.meta.url);
  const doc = (await Bun.file(schemaUrl).json()) as OpenRpcDocument;
  const generated = generateHcApi(doc, PROJECTED_METHODS);
  const problems = missingRequiredMethods(generated.methods, REQUIRED_HC_METHODS);

  if (mode === "--write") {
    if (problems.length === 0) {
      await Bun.write(outputUrl, generated.source);
      console.log(`Wrote hc protocol types for ${generated.methods.length} methods.`);
    }
  } else if (mode === "--check") {
    const output = Bun.file(outputUrl);
    const current = (await output.exists()) ? await output.text() : "";
    if (current !== generated.source) {
      problems.push("Generated hc protocol types are stale; run bun run protocol:generate");
    }
    if (problems.length === 0) {
      console.log(`hc protocol types are current: ${generated.methods.length} methods.`);
    }
  } else {
    problems.push("Usage: bun packages/protocol/scripts/hc-api.ts --write | --check");
  }
  for (const problem of problems) console.error(problem);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv[2]));
}
