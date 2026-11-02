// The prototype's scratch session: its own HC_SESSION, HOME and XDG directories under one temp
// root, the way herdr-core's tests isolate a core (tests/common/mod.rs). A child gets only these,
// PATH and the locale, never the caller's HC_SOCKET or terminal identity, so nothing it starts
// can reach the person's own core. Every spawn is checked again right before it happens.

import type { OwnedProcess, ProcessRunner } from "./process.ts";

export interface ScratchContext {
  /** The temp root everything else lives under. */
  root: string;
  /** HC_SESSION: a fresh name, never `default`. */
  session: string;
  home: string;
  /** XDG_RUNTIME_DIR, where the core puts its socket. */
  runtime: string;
  /** XDG_STATE_HOME. */
  state: string;
  /** XDG_CONFIG_HOME. */
  config: string;
  /** The fixture's working directory. */
  cwd: string;
  /** Creating this file lets the fixture report its status and print its live marker. */
  gate: string;
}

export interface ScratchFs {
  /** Creates a new directory named `prefix` plus a random suffix, and returns its path. */
  makeTempDir(prefix: string): string;
  makeDir(path: string): void;
  writeFile(path: string, text: string): void;
  /** Removes a directory and everything in it. */
  remove(path: string): void;
}

export type Env = Record<string, string | undefined>;

/** What a child may take from the caller's environment. */
const PASSED = ["PATH", "LANG", "LC_ALL", "LC_CTYPE"];
/** What would point a child at another core, or make it act as some terminal. */
const FORBIDDEN = ["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_RUNTIME"];
const DIRECTORIES = [
  ["HOME", "home"],
  ["XDG_RUNTIME_DIR", "runtime"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_CONFIG_HOME", "config"],
] as const;

export const ISOLATION_REQUIRED = "SCRATCH_ISOLATION_REQUIRED";

export function createScratchContext(fs: ScratchFs, random: () => string): ScratchContext {
  // A short root under /tmp: the socket path has to fit in sockaddr_un (104 bytes on macOS).
  const root = fs.makeTempDir("/tmp/hmp-");
  const context: ScratchContext = {
    root,
    session: `hmp-${random()}`,
    home: `${root}/home`,
    runtime: `${root}/run`,
    state: `${root}/state`,
    config: `${root}/config`,
    cwd: `${root}/cwd`,
    gate: `${root}/gate`,
  };
  for (const dir of [context.home, context.runtime, context.state, context.config, context.cwd]) {
    fs.makeDir(dir);
  }
  return context;
}

/** The whole environment for a child of `context`. */
export function scratchEnv(context: ScratchContext, parent: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.HC_SESSION = context.session;
  for (const [key, field] of DIRECTORIES) env[key] = context[field];
  return env;
}

/** Why `env` can't be given to a child of `context`, or undefined when it can. */
export function isolationProblem(context: unknown, env: Env): string | undefined {
  if (!isComplete(context)) return ISOLATION_REQUIRED;
  for (const key of FORBIDDEN) {
    if (env[key] !== undefined) return `${key} must not be inherited`;
  }
  if (env.HC_SESSION !== context.session) return "scratch environment missing HC_SESSION";
  for (const [key, field] of DIRECTORIES) {
    if (env[key] === undefined) return `scratch environment missing ${key}`;
    if (env[key] !== context[field]) return `${key} is outside the scratch root`;
  }
  const allowed = new Set([...PASSED, "HC_SESSION", ...DIRECTORIES.map(([key]) => key)]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) return `scratch environment carries ${key}`;
  }
  return undefined;
}

/**
 * Starts `hc connect` for `context` with `env`, after checking both. A cleanup connection's
 * refusal says it would have escaped the scratch context.
 */
export function spawnScratchConnect(
  context: ScratchContext | undefined,
  env: Env,
  runner: ProcessRunner,
  purpose: "workflow" | "cleanup",
): OwnedProcess {
  const problem = isolationProblem(context, env);
  if (problem || !context) {
    const reason = problem ?? ISOLATION_REQUIRED;
    throw new Error(purpose === "cleanup" ? `cleanup escaped scratch context: ${reason}` : reason);
  }
  return runner.spawn(["hc", "connect"], { env: env as Record<string, string>, cwd: context.cwd });
}

function isComplete(context: unknown): context is ScratchContext {
  if (typeof context !== "object" || context === null) return false;
  const c = context as Partial<ScratchContext>;
  if (typeof c.root !== "string" || !c.root.startsWith("/") || c.root.length < 2) return false;
  if (typeof c.session !== "string" || c.session === "" || c.session === "default") return false;
  const inside = (path: unknown) => typeof path === "string" && path.startsWith(`${c.root}/`);
  return [c.home, c.runtime, c.state, c.config, c.cwd, c.gate].every(inside);
}
