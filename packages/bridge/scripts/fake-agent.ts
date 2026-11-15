#!/usr/bin/env bun
/**
 * Scratch stand-in for `claude` and `codex`. Run it from a wrapper placed first on PATH.
 *
 * Options may come from a JSON object named by `HERDR_FAKE_AGENT_CONFIG`, then be overridden
 * by environment variables:
 *   mode: "done" | "blocked" (`HERDR_FAKE_AGENT_MODE`, default "done")
 *   delayMs: milliseconds between status changes (`HERDR_FAKE_AGENT_DELAY_MS`, default 400)
 *   exitCode: process exit code (`HERDR_FAKE_AGENT_EXIT_CODE`, default 0)
 *   msg: optional done-status message (`HERDR_FAKE_AGENT_MSG`)
 *   lastLine: canned final screen line (`HERDR_FAKE_AGENT_LAST_LINE`)
 *   question: blocked menu question (`HERDR_FAKE_AGENT_QUESTION`)
 *   choices: menu labels (`HERDR_FAKE_AGENT_CHOICES`, separated by |)
 *
 * In blocked mode the fake waits for input, reports working, then reports done. In done mode it
 * reports working and done on the configured schedule. The first output line is its exact argv.
 */
import { readFile } from "node:fs/promises";

export interface FakeAgentOptions {
  mode: "done" | "blocked";
  delayMs: number;
  exitCode: number;
  msg?: string;
  lastLine: string;
  question: string;
  choices: string[];
}

export interface FakeAgentIo {
  write(text: string): void;
  delay(ms: number): Promise<void>;
  waitForReply(): Promise<void>;
}

const DEFAULT_OPTIONS: FakeAgentOptions = {
  mode: "done",
  delayMs: 400,
  exitCode: 0,
  lastLine: "Fake agent finished the task.",
  question: "May I continue with this change?",
  choices: ["Yes", "No"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function normalizeFileOptions(value: unknown): Partial<FakeAgentOptions> {
  if (!isRecord(value)) throw new Error("fake-agent config must be a JSON object");
  const result: Partial<FakeAgentOptions> = {};
  if (value.mode === "done" || value.mode === "blocked") result.mode = value.mode;
  else if (value.mode !== undefined) throw new Error("mode must be done or blocked");
  if (typeof value.delayMs === "number" && Number.isSafeInteger(value.delayMs)) {
    result.delayMs = value.delayMs;
  } else if (value.delayMs !== undefined) {
    throw new Error("delayMs must be an integer");
  }
  if (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)) {
    result.exitCode = value.exitCode;
  } else if (value.exitCode !== undefined) {
    throw new Error("exitCode must be an integer");
  }
  for (const key of ["msg", "lastLine", "question"] as const) {
    const field = value[key];
    if (typeof field === "string") result[key] = field;
    else if (field !== undefined) throw new Error(`${key} must be a string`);
  }
  if (Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === "string")) {
    result.choices = value.choices;
  } else if (value.choices !== undefined) {
    throw new Error("choices must be a list of strings");
  }
  return result;
}

/** Read file options first, then apply environment variable overrides. */
export async function readFakeAgentOptions(
  env: Record<string, string | undefined>,
): Promise<FakeAgentOptions> {
  let fileOptions: Partial<FakeAgentOptions> = {};
  const configPath = env.HERDR_FAKE_AGENT_CONFIG;
  if (configPath) {
    fileOptions = normalizeFileOptions(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  }

  const mode = env.HERDR_FAKE_AGENT_MODE ?? fileOptions.mode ?? DEFAULT_OPTIONS.mode;
  if (mode !== "done" && mode !== "blocked") throw new Error("mode must be done or blocked");
  const delayMs = parseInteger(
    env.HERDR_FAKE_AGENT_DELAY_MS,
    fileOptions.delayMs ?? DEFAULT_OPTIONS.delayMs,
    "delayMs",
  );
  if (delayMs < 0 || delayMs > 60_000) throw new Error("delayMs must be between 0 and 60000");
  const exitCode = parseInteger(
    env.HERDR_FAKE_AGENT_EXIT_CODE,
    fileOptions.exitCode ?? DEFAULT_OPTIONS.exitCode,
    "exitCode",
  );
  const choices = env.HERDR_FAKE_AGENT_CHOICES
    ? env.HERDR_FAKE_AGENT_CHOICES.split("|").filter(Boolean)
    : (fileOptions.choices ?? DEFAULT_OPTIONS.choices);
  return {
    mode,
    delayMs,
    exitCode,
    lastLine: env.HERDR_FAKE_AGENT_LAST_LINE ?? fileOptions.lastLine ?? DEFAULT_OPTIONS.lastLine,
    question: env.HERDR_FAKE_AGENT_QUESTION ?? fileOptions.question ?? DEFAULT_OPTIONS.question,
    choices,
    ...((env.HERDR_FAKE_AGENT_MSG ?? fileOptions.msg) === undefined
      ? {}
      : { msg: env.HERDR_FAKE_AGENT_MSG ?? fileOptions.msg }),
  };
}

function escapeStatusValue(value: string): string {
  return value.replaceAll("\u001b", "").replaceAll("\u0007", "").replaceAll(";", ",");
}

function report(io: FakeAgentIo, state: string, msg?: string): void {
  const status = `state=${state}${msg === undefined ? "" : `;msg=${escapeStatusValue(msg)}`}`;
  io.write(`\u001b]7501;${status}\u001b\\`);
}

function printMenu(io: FakeAgentIo, options: FakeAgentOptions): void {
  io.write(`${options.question}\r\n`);
  for (const [index, choice] of options.choices.entries()) {
    io.write(`${index + 1}. ${choice}\r\n`);
  }
}

export async function runFakeAgent(
  argv: readonly string[],
  options: FakeAgentOptions,
  io: FakeAgentIo,
): Promise<number> {
  io.write(`${JSON.stringify(argv)}\r\n`);
  report(io, "working");
  await io.delay(options.delayMs);
  if (options.mode === "blocked") {
    printMenu(io, options);
    report(io, "blocked", options.question);
    await io.waitForReply();
    report(io, "working");
    await io.delay(options.delayMs);
  }
  io.write(`${options.lastLine}\r\n`);
  report(io, "done", options.msg);
  return options.exitCode;
}

const processIo: FakeAgentIo = {
  write(text) {
    process.stdout.write(text);
  },
  delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  },
  waitForReply() {
    return new Promise((resolveReply) => {
      process.stdin.once("data", () => resolveReply());
      process.stdin.resume();
    });
  },
};

if (import.meta.main) {
  try {
    const options = await readFakeAgentOptions(process.env);
    process.exitCode = await runFakeAgent(process.argv.slice(2), options, processIo);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
