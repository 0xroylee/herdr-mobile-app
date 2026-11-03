import type { Role } from "./bridge.ts";
import type { JsonValue } from "./wire.ts";

/** Methods a device with the watch role may call, subject to `terminal.attach`. */
const WATCH_METHODS = [
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

/** Methods a control device may call. */
const CONTROL_ONLY_METHODS = [
  "terminal.send",
  "terminal.keys",
  "terminal.interrupt",
  "terminal.wait",
  "terminal.kill",
  "terminal.keep",
  "terminal.label",
] as const;

/** Core methods the bridge never forwards, for either role. */
export const NEVER_FORWARDED = [
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

/** Role-specific core method allow-lists. */
export const METHODS_BY_ROLE = {
  watch: WATCH_METHODS,
  control: [...WATCH_METHODS, ...CONTROL_ONLY_METHODS],
} as const satisfies Record<Role, readonly string[]>;

const NEVER_FORWARDED_SET: ReadonlySet<string> = new Set(NEVER_FORWARDED);
const METHODS_BY_ROLE_SET: Readonly<Record<Role, ReadonlySet<string>>> = {
  watch: new Set(METHODS_BY_ROLE.watch),
  control: new Set(METHODS_BY_ROLE.control),
};

/** Return whether a core method may pass through for this device role. */
export function isAllowed(role: Role, method: string, params?: JsonValue): boolean {
  if (NEVER_FORWARDED_SET.has(method) || !METHODS_BY_ROLE_SET[role].has(method)) {
    return false;
  }

  if (role === "watch" && method === "terminal.attach") {
    return isJsonObject(params) && params.observe === true;
  }

  return true;
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
