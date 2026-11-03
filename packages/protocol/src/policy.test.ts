import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Role } from "./bridge.ts";
import { REQUIRED_HC_METHODS } from "./index.ts";
import { isAllowed } from "./policy.ts";
import type { JsonValue } from "./wire.ts";

interface OpenRpcDocument {
  methods: { name: string }[];
}

interface PolicyCase {
  role: Role;
  method: string;
  params?: JsonValue;
  allowed: boolean;
}

const schema = JSON.parse(
  readFileSync(new URL("../schema/hc.openrpc.json", import.meta.url), "utf8"),
) as OpenRpcDocument;

const EXPECTED_WATCH_METHODS = [
  "hello",
  "server.status",
  "terminal.list",
  "terminal.get",
  "terminal.read",
  "terminal.attach",
  "events.subscribe",
  "doc.get",
  "machine.list",
  "templates.list",
  "rpc.discover",
] as const;

const EXPECTED_CONTROL_ONLY_METHODS = [
  "terminal.send",
  "terminal.keys",
  "terminal.interrupt",
  "terminal.wait",
  "terminal.kill",
  "terminal.keep",
  "terminal.label",
] as const;

const EXPECTED_NEVER_FORWARDED_METHODS = [
  "server.stop",
  "server.restart",
  "terminal.run",
  "doc.set",
  "terminal.rm",
  "terminal.put",
  "machine.exec",
  "machine.add",
  "machine.rm",
  "machine.rename",
  "machine.connect",
  "file.read",
  "file.write",
  "file.edit",
] as const;

describe("bridge method policy", () => {
  it("keeps the literal policy lists disjoint and complete for the pinned schema", () => {
    const watchMethods = new Set<string>(EXPECTED_WATCH_METHODS);
    const controlOnlyMethods = new Set<string>(EXPECTED_CONTROL_ONLY_METHODS);
    const neverForwardedMethods = new Set<string>(EXPECTED_NEVER_FORWARDED_METHODS);
    const policyMethods: string[] = [
      ...EXPECTED_WATCH_METHODS,
      ...EXPECTED_CONTROL_ONLY_METHODS,
      ...EXPECTED_NEVER_FORWARDED_METHODS,
    ];
    const policyMethodSet = new Set<string>(policyMethods);
    const schemaMethods = schema.methods.map(({ name }) => name);

    expect(EXPECTED_WATCH_METHODS).toHaveLength(11);
    expect(EXPECTED_CONTROL_ONLY_METHODS).toHaveLength(7);
    expect(EXPECTED_NEVER_FORWARDED_METHODS).toHaveLength(14);
    expect(
      policyMethods.filter((method, index) => policyMethods.indexOf(method) !== index),
    ).toEqual([]);
    expect(watchMethods.size + controlOnlyMethods.size + neverForwardedMethods.size).toBe(32);
    expect(schemaMethods).toHaveLength(32);
    expect([...policyMethods].sort()).toEqual([...schemaMethods].sort());
    expect(REQUIRED_HC_METHODS.filter((method) => !policyMethodSet.has(method))).toEqual([]);
  });

  it("applies the expected decision to every method for both roles", () => {
    const cases: PolicyCase[] = [];

    for (const method of EXPECTED_WATCH_METHODS) {
      cases.push({
        role: "watch",
        method,
        ...(method === "terminal.attach" ? { params: { observe: true } } : {}),
        allowed: true,
      });
      cases.push({ role: "control", method, allowed: true });
    }
    for (const method of EXPECTED_CONTROL_ONLY_METHODS) {
      cases.push({ role: "watch", method, allowed: false });
      cases.push({ role: "control", method, allowed: true });
    }
    for (const method of EXPECTED_NEVER_FORWARDED_METHODS) {
      cases.push({ role: "watch", method, allowed: false });
      cases.push({ role: "control", method, allowed: false });
    }

    expect(cases).toHaveLength(64);
    const actual = cases.map(({ role, method, params }) => ({
      role,
      method,
      allowed: isAllowed(role, method, params),
    }));
    const expected = cases.map(({ role, method, allowed }) => ({ role, method, allowed }));
    expect(actual).toEqual(expected);
  });

  it("denies unknown methods for both roles, including prototype names", () => {
    const unknownMethods = [
      "file.list",
      "terminal.unknown",
      "server.anything",
      "",
      "Hello",
      " hello",
      "hello ",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ];
    const roles: Role[] = ["watch", "control"];
    const cases = unknownMethods.flatMap((method) =>
      roles.map((role) => ({ role, method, allowed: false })),
    );
    const actual = cases.map(({ role, method }) => ({
      role,
      method,
      allowed: isAllowed(role, method),
    }));

    expect(actual).toEqual(cases);
  });

  it("never forwards terminal.run, with or without a shell line", () => {
    const parameterForms: { label: string; params?: JsonValue }[] = [
      { label: "omitted" },
      { label: "without line", params: { terminal: "t1" } },
      { label: "with line", params: { terminal: "t1", line: "echo unsafe" } },
    ];
    const roles: Role[] = ["watch", "control"];

    for (const role of roles) {
      for (const { params } of parameterForms) {
        expect(isAllowed(role, "terminal.run", params)).toBe(false);
      }
    }
  });

  it("denies watch attachments unless observe is exactly true", () => {
    const invalidParams: { label: string; params?: JsonValue }[] = [
      { label: "omitted" },
      { label: "null", params: null },
      { label: "empty array", params: [] },
      { label: "array with observe", params: [{ observe: true }] },
      { label: "string", params: "observe" },
      { label: "number", params: 1 },
      { label: "boolean", params: true },
      { label: "empty object", params: {} },
      { label: "false", params: { observe: false } },
      { label: "string true", params: { observe: "true" } },
      { label: "number one", params: { observe: 1 } },
      { label: "null observe", params: { observe: null } },
    ];
    const actual = invalidParams.map(({ label, params }) => ({
      label,
      allowed: isAllowed("watch", "terminal.attach", params),
    }));

    expect(actual).toEqual(invalidParams.map(({ label }) => ({ label, allowed: false })));
    expect(isAllowed("watch", "terminal.attach", { observe: true })).toBe(true);
    expect(isAllowed("watch", "terminal.attach", { observe: true, terminal: "t1" })).toBe(true);
  });

  it("allows control attachments with any of the listed parameter forms", () => {
    const validParams: { label: string; params?: JsonValue }[] = [
      { label: "omitted" },
      { label: "empty object", params: {} },
      { label: "false", params: { observe: false } },
      { label: "true", params: { observe: true } },
    ];
    const actual = validParams.map(({ label, params }) => ({
      label,
      allowed: isAllowed("control", "terminal.attach", params),
    }));

    expect(actual).toEqual(validParams.map(({ label }) => ({ label, allowed: true })));
  });
});
