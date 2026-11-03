import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HcRpcError } from "@herdr-mobile/hc-client";
import type {
  AgentCatalog,
  AgentCatalogTemplate,
  DeviceRecordView,
  StartAgentErrorCode,
  StartAgentReply,
  StartAgentRequest,
} from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { DeadlineError, systemClock, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import { runHerdrApp } from "./app-cli.ts";
import { type CoreMethod, callCore, HcConnectError } from "./core-call.ts";

const MAX_START_STRING_BYTES = 32 * 1024;
const FOLDER_CHECK_TIMEOUT_MS = 10_000;
const PROGRAM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface StatFs {
  realPath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export const nodeStatFs: StatFs = {
  async realPath(path) {
    return await realpath(path);
  },
  async stat(path) {
    return await stat(path);
  },
};

export type CoreCaller = (method: CoreMethod, params: unknown) => Promise<unknown>;
export type StartIdGenerator = (prefix: "sp" | "tb") => string;

export interface AgentStarterConfig {
  runner: ProcessRunner;
  statFs?: StatFs;
  coreCall?: CoreCaller;
  clock?: Clock;
  programs: string[];
  roots: string[];
  home: string;
  herdrAppPath: string;
  hcPath: string;
  session?: string;
  env: Record<string, string>;
  cwd: string;
  idGenerator?: StartIdGenerator;
  output?: (line: string) => void;
}

export class StartAgentError extends Error {
  readonly status: number;
  readonly code: StartAgentErrorCode;
  readonly kind: string | undefined;

  constructor(status: number, code: StartAgentErrorCode, message: string, kind?: string) {
    super(message);
    this.name = "StartAgentError";
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

interface ResolvedRun {
  name: string;
  kind: "program" | "template";
}

interface ParsedAppOutput {
  address?: string;
  spaceId?: string;
  tabId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultId(prefix: "sp" | "tb"): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

function isUnder(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function uniqueResolvedRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function validateRequest(request: StartAgentRequest): void {
  if (!isRecord(request) || !isRecord(request.run) || !isRecord(request.space)) {
    throw new StartAgentError(400, "run_not_allowed", "The start request is invalid.");
  }
  if (
    typeof request.folder !== "string" ||
    new TextEncoder().encode(request.folder).byteLength > MAX_START_STRING_BYTES ||
    request.folder.includes("\0")
  ) {
    throw new StartAgentError(400, "folder_not_allowed", "Choose a valid folder.");
  }
  if (
    request.task !== undefined &&
    (typeof request.task !== "string" ||
      new TextEncoder().encode(request.task).byteLength > MAX_START_STRING_BYTES ||
      request.task.includes("\0"))
  ) {
    throw new StartAgentError(400, "run_not_allowed", "The first message is too long or invalid.");
  }
  if (request.run.kind === "program") {
    if (typeof request.run.id !== "string" || !PROGRAM_PATTERN.test(request.run.id)) {
      throw new StartAgentError(422, "run_not_allowed", "That program is not allowed.");
    }
  } else if (request.run.kind === "template") {
    if (typeof request.run.name !== "string" || request.run.name.length === 0) {
      throw new StartAgentError(422, "run_not_allowed", "That template is not allowed.");
    }
  } else {
    throw new StartAgentError(422, "run_not_allowed", "That run is not allowed.");
  }
  if (request.space.kind === "existing") {
    if (typeof request.space.id !== "string" || request.space.id.length === 0) {
      throw new StartAgentError(400, "run_not_allowed", "Choose a space.");
    }
  } else if (request.space.kind === "new") {
    if (
      request.space.name !== undefined &&
      (typeof request.space.name !== "string" ||
        new TextEncoder().encode(request.space.name).byteLength > MAX_START_STRING_BYTES ||
        request.space.name.includes("\0"))
    ) {
      throw new StartAgentError(400, "run_not_allowed", "Choose a valid space name.");
    }
  } else {
    throw new StartAgentError(400, "run_not_allowed", "Choose a space.");
  }
}

function parseTemplates(value: unknown): AgentCatalogTemplate[] {
  if (!isRecord(value) || !Array.isArray(value.templates)) {
    throw new Error("templates.list returned an invalid result");
  }
  return value.templates.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      typeof candidate.description !== "string" ||
      (candidate.error !== undefined && candidate.error !== null)
    ) {
      return [];
    }
    return [{ name: candidate.name, description: candidate.description }];
  });
}

function parseAppOutput(stdout: string): ParsedAppOutput {
  const values: unknown[] = [];
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      for (const line of trimmed.split(/\r?\n/u)) {
        try {
          values.push(JSON.parse(line) as unknown);
        } catch {
          // Non-JSON output carries no address or location identifiers.
        }
      }
    }
  }
  for (const value of values) {
    if (!isRecord(value)) continue;
    const record = isRecord(value.result) ? value.result : value;
    const space = isRecord(record.space) ? record.space : undefined;
    const tab = isRecord(record.tab) ? record.tab : undefined;
    const parsed: ParsedAppOutput = {};
    if (typeof record.address === "string") parsed.address = record.address;
    else if (typeof record.terminal === "string") parsed.address = record.terminal;
    if (typeof record.space_id === "string") parsed.spaceId = record.space_id;
    else if (typeof record.spaceId === "string") parsed.spaceId = record.spaceId;
    else if (typeof record.space === "string") parsed.spaceId = record.space;
    else if (typeof space?.id === "string") parsed.spaceId = space.id;
    if (typeof record.tab_id === "string") parsed.tabId = record.tab_id;
    else if (typeof record.tabId === "string") parsed.tabId = record.tabId;
    else if (typeof record.tab === "string") parsed.tabId = record.tab;
    else if (typeof tab?.id === "string") parsed.tabId = tab.id;
    if (
      parsed.address !== undefined ||
      parsed.spaceId !== undefined ||
      parsed.tabId !== undefined
    ) {
      return parsed;
    }
  }
  return {};
}

function mapCoreError(error: unknown): StartAgentError {
  const kind =
    error instanceof HcRpcError || error instanceof HcConnectError ? error.kind : undefined;
  return new StartAgentError(502, "core_unavailable", errorMessage(error), kind);
}

/** Keeps template discovery, folder policy, window detection, and placement behind two methods. */
export class AgentStarter {
  private readonly config: AgentStarterConfig;
  private readonly statFs: StatFs;
  private readonly coreCall: CoreCaller;
  private readonly clock: Clock;
  private readonly idGenerator: StartIdGenerator;
  private readonly output: (line: string) => void;

  constructor(config: AgentStarterConfig) {
    this.config = config;
    this.statFs = config.statFs ?? nodeStatFs;
    this.coreCall =
      config.coreCall ??
      ((method, params) =>
        callCore(
          {
            runner: config.runner,
            hcPath: config.hcPath,
            ...(config.session === undefined ? {} : { session: config.session }),
            env: config.env,
            cwd: config.cwd,
            clock: config.clock,
          },
          method,
          params,
        ));
    this.clock = config.clock ?? systemClock;
    this.idGenerator = config.idGenerator ?? defaultId;
    this.output = config.output ?? (() => {});
  }

  async catalog(): Promise<AgentCatalog> {
    const [templatesResult, windowOpen] = await Promise.allSettled([
      this.loadTemplates(),
      this.probeWindow(),
    ]);
    const templates = templatesResult.status === "fulfilled" ? templatesResult.value : [];
    return {
      programs: [...this.config.programs],
      templates,
      ...(templatesResult.status === "rejected"
        ? { templatesError: errorMessage(templatesResult.reason) }
        : {}),
      roots: uniqueResolvedRoots(this.config.roots),
      home: resolve(this.config.home),
      windowOpen: windowOpen.status === "fulfilled" && windowOpen.value,
    };
  }

  async start(request: StartAgentRequest, caller: DeviceRecordView): Promise<StartAgentReply> {
    if (caller.role !== "control") {
      throw new StartAgentError(403, "forbidden", "This device is read-only.");
    }
    validateRequest(request);
    const run = await this.resolveRun(request.run);
    const folder = await this.resolveFolder(request.folder);
    const windowOpen = await this.probeWindow();

    let reply: StartAgentReply;
    if (windowOpen) {
      reply = await this.startInWindow(request, run, folder);
    } else {
      if (run.kind === "program" && request.task) {
        throw new StartAgentError(
          422,
          "run_not_allowed",
          `First messages for ${run.name} need Herdr open on your Mac. Open Herdr, or leave the message empty.`,
        );
      }
      reply = await this.startInCore(request, run, folder, caller);
    }
    this.logSuccessfulStart(caller, run, folder, reply);
    return reply;
  }

  private async loadTemplates(): Promise<AgentCatalogTemplate[]> {
    const result = await this.coreCall("templates.list", {});
    return parseTemplates(result);
  }

  private async resolveRun(run: StartAgentRequest["run"]): Promise<ResolvedRun> {
    if (run.kind === "program") {
      if (!this.config.programs.includes(run.id)) {
        throw new StartAgentError(422, "run_not_allowed", "That program is not allowed.");
      }
      return { name: run.id, kind: "program" };
    }

    let templates: AgentCatalogTemplate[];
    try {
      templates = await this.loadTemplates();
    } catch (error) {
      throw mapCoreError(error);
    }
    if (!templates.some((template) => template.name === run.name)) {
      throw new StartAgentError(422, "run_not_allowed", "Herdr doesn't know this template.");
    }
    return { name: run.name, kind: "template" };
  }

  private async resolveFolder(folder: string): Promise<string> {
    if (!isAbsolute(folder) && folder !== "~" && !folder.startsWith("~/")) {
      throw new StartAgentError(
        422,
        "folder_not_allowed",
        "Choose an absolute folder under an allowed root.",
      );
    }
    const resolved =
      folder === "~"
        ? resolve(this.config.home)
        : folder.startsWith("~/")
          ? resolve(this.config.home, folder.slice(2))
          : resolve(folder);
    try {
      return await within(
        "folder verification",
        (async () => {
          const canonicalFolder = await this.statFs.realPath(resolved);
          const canonicalRoots = await Promise.all(
            this.config.roots.map((root) => this.statFs.realPath(resolve(root))),
          );
          if (!canonicalRoots.some((root) => isUnder(root, canonicalFolder))) {
            throw new StartAgentError(
              422,
              "folder_not_allowed",
              "That folder is outside the allowed roots.",
            );
          }
          const details = await this.statFs.stat(canonicalFolder);
          if (!details.isDirectory()) {
            throw new StartAgentError(422, "folder_missing", "That folder does not exist.");
          }
          return canonicalFolder;
        })(),
        FOLDER_CHECK_TIMEOUT_MS,
        this.clock,
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof StartAgentError) throw error;
      if (error instanceof DeadlineError) {
        throw new StartAgentError(422, "folder_missing", "That folder did not respond in time.");
      }
      throw new StartAgentError(422, "folder_missing", "That folder does not exist.");
    }
  }

  private logSuccessfulStart(
    caller: DeviceRecordView,
    run: ResolvedRun,
    folder: string,
    reply: StartAgentReply,
  ): void {
    const record = {
      time: new Date(this.clock.now()).toISOString(),
      device: { id: caller.id, name: caller.name, role: caller.role },
      run:
        run.kind === "program"
          ? { kind: run.kind, id: run.name }
          : { kind: run.kind, name: run.name },
      folder,
      placement: reply.placement,
      ...(reply.address === undefined ? {} : { address: reply.address }),
      space: reply.space,
      tab: reply.tab,
    };
    try {
      this.output(`Agent started ${JSON.stringify(record)}`);
    } catch {
      // Logging must not turn a completed start into an API error.
    }
  }

  private async probeWindow(): Promise<boolean> {
    try {
      const result = await runHerdrApp(
        {
          runner: this.config.runner,
          env: this.config.env,
          cwd: this.config.cwd,
          herdrAppPath: this.config.herdrAppPath,
          clock: this.clock,
        },
        [this.config.herdrAppPath, "ls"],
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async startInWindow(
    request: StartAgentRequest,
    run: ResolvedRun,
    folder: string,
  ): Promise<StartAgentReply> {
    const task = request.task;
    const args: Record<string, unknown> = {
      folder,
      argv: [run.name],
      ...(task ? { task } : {}),
    };
    const action = request.space.kind === "new" ? "space.new" : "tab.new";
    if (request.space.kind === "existing") {
      args.space = request.space.id;
    } else if (request.space.name !== undefined && request.space.name !== "") {
      args.name = request.space.name;
    }

    let result: Awaited<ReturnType<typeof runHerdrApp>>;
    try {
      result = await runHerdrApp(
        {
          runner: this.config.runner,
          env: this.config.env,
          cwd: this.config.cwd,
          herdrAppPath: this.config.herdrAppPath,
          clock: this.clock,
        },
        [this.config.herdrAppPath, "do", action, JSON.stringify(args)],
      );
    } catch (error) {
      if (error instanceof DeadlineError) {
        throw new StartAgentError(504, "herdr_app_timeout", error.message);
      }
      throw new StartAgentError(409, "herdr_app_failed", errorMessage(error));
    }
    if (result.exitCode !== 0) {
      throw new StartAgentError(
        409,
        "herdr_app_failed",
        result.stderr || "herdr-app could not start the agent.",
      );
    }

    const parsed = parseAppOutput(result.stdout);
    const isNewSpace = request.space.kind === "new";
    return {
      placement: "window",
      ...(parsed.address === undefined ? {} : { address: parsed.address }),
      space: {
        id: request.space.kind === "existing" ? request.space.id : (parsed.spaceId ?? ""),
        isNew: isNewSpace,
      },
      tab: { id: parsed.tabId ?? "", isNew: true },
    };
  }

  private async startInCore(
    request: StartAgentRequest,
    run: ResolvedRun,
    folder: string,
    caller: DeviceRecordView,
  ): Promise<StartAgentReply> {
    const spaceIsNew = request.space.kind === "new";
    const spaceId = request.space.kind === "new" ? this.idGenerator("sp") : request.space.id;
    const tabId = this.idGenerator("tb");
    const argv = [run.name];
    if (run.kind === "template" && request.task) argv.push(request.task);
    const params = {
      argv,
      cwd: folder,
      labels: {
        "herdr.space": spaceId,
        "herdr.tab": tabId,
        "herdr-mobile.origin": caller.id,
      },
      keep: true,
      no_parent: true,
      wait: false,
    };
    try {
      const result = await this.coreCall("terminal.run", params);
      if (!isRecord(result) || typeof result.address !== "string") {
        throw new Error("terminal.run returned an invalid result");
      }
      return {
        placement: "core",
        address: result.address,
        space: { id: spaceId, isNew: spaceIsNew },
        tab: { id: tabId, isNew: true },
      };
    } catch (error) {
      throw mapCoreError(error);
    }
  }
}
