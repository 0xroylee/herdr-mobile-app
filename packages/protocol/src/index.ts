// Wire types shared by the bridge and the app. The herdr-core API is pinned in
// `schema/hc.openrpc.json`; types generated from it and the bridge's own messages go here.

/** Protocol generation this client speaks. `hello` reports the core's. */
export const HC_PROTOCOL_GENERATION = 1;

/** herdr-core methods the bridge and app depend on. The schema test fails if one disappears. */
export const REQUIRED_HC_METHODS = [
  "hello",
  "terminal.list",
  "terminal.get",
  "terminal.read",
  "terminal.attach",
  "terminal.send",
  "terminal.keys",
  "terminal.run",
  "events.subscribe",
  "doc.get",
] as const;

export type RequiredHcMethod = (typeof REQUIRED_HC_METHODS)[number];

export * from "./bridge.ts";
export type * from "./generated/hc-api.ts";
export * from "./herdr-app-doc.ts";
export * from "./policy.ts";
export * from "./wire.ts";
