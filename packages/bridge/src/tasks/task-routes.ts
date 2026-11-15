import type {
  CheckTaskRequest,
  ClearTasksRequest,
  DeviceRecordView,
  LinkTaskRequest,
  StartAgentRun,
  StartAgentSpace,
  StartTaskReply,
  StartTaskRequest,
  TaskErrorCode,
  UncheckTaskRequest,
} from "@herdr-mobile/protocol";
import { TASK_TEXT_MAX_BYTES } from "@herdr-mobile/protocol";
import { authenticatedCaller, requestBody } from "../server/app-cli.ts";
import type { ResolveCaller } from "../server/caller.ts";
import type { CoreMethod } from "../server/core-call.ts";
import { type AgentStarter, StartAgentError } from "../server/start-agent.ts";
import { type TaskStore, TaskStoreError } from "./task-store.ts";

const encoder = new TextEncoder();

export interface TaskRoutesContext {
  starter: AgentStarter;
  store: TaskStore;
  coreCall: (method: CoreMethod, params: unknown) => Promise<unknown>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRun(value: unknown): value is StartAgentRun {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "program" &&
      typeof value.id === "string" &&
      hasOnlyKeys(value, ["kind", "id"])) ||
    (value.kind === "template" &&
      typeof value.name === "string" &&
      hasOnlyKeys(value, ["kind", "name"]))
  );
}

function isSpace(value: unknown): value is StartAgentSpace {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "existing" &&
      typeof value.id === "string" &&
      hasOnlyKeys(value, ["kind", "id"])) ||
    (value.kind === "new" &&
      (value.name === undefined || typeof value.name === "string") &&
      hasOnlyKeys(value, ["kind", "name"]))
  );
}

function isTaskRequest(value: unknown): value is StartTaskRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["text", "run", "folder", "space", "tab", "placement"]) ||
    typeof value.text !== "string" ||
    typeof value.folder !== "string" ||
    !isRun(value.run) ||
    !isSpace(value.space) ||
    (value.tab !== undefined &&
      (!isRecord(value.tab) ||
        typeof value.tab.id !== "string" ||
        !hasOnlyKeys(value.tab, ["id"]))) ||
    (value.placement !== undefined && value.placement !== "window" && value.placement !== "core")
  ) {
    return false;
  }
  return true;
}

function isCheckRequest(value: unknown): value is CheckTaskRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.turn) || (value.turn as number) < 0) {
    return false;
  }
  return (
    (typeof value.id === "string" && hasOnlyKeys(value, ["id", "turn"])) ||
    (typeof value.terminal === "string" && hasOnlyKeys(value, ["terminal", "turn"]))
  );
}

function isUncheckRequest(value: unknown): value is UncheckTaskRequest {
  return isRecord(value) && typeof value.id === "string" && hasOnlyKeys(value, ["id"]);
}

function isLinkRequest(value: unknown): value is LinkTaskRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.terminal === "string" &&
    hasOnlyKeys(value, ["id", "terminal"])
  );
}

function isClearRequest(value: unknown): value is ClearTasksRequest {
  return (
    isRecord(value) &&
    (value.spaceId === undefined || typeof value.spaceId === "string") &&
    hasOnlyKeys(value, ["spaceId"])
  );
}

function startError(error: StartAgentError): Response {
  return json(
    { error: error.code, message: error.message, ...(error.kind ? { kind: error.kind } : {}) },
    error.status,
  );
}

function storeError(error: TaskStoreError): Response {
  const knownCode: TaskErrorCode = error.code === "conflict" ? "core_unavailable" : error.code;
  const message =
    knownCode === "core_unavailable"
      ? "Can’t reach your Mac."
      : knownCode === "tasks_full"
        ? "Check off and clear old tasks first."
        : undefined;
  const status =
    error.code === "task_not_found"
      ? 404
      : error.code === "task_linked"
        ? 409
        : error.code === "tasks_full"
          ? 507
          : 503;
  return json({ error: knownCode, ...(message === undefined ? {} : { message }) }, status);
}

function taskTextError(): Response {
  return json({ error: "task_not_allowed", message: "Write the task as a sentence." }, 422);
}

function liveAddresses(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.terminals))
    throw new TaskStoreError("core_unavailable");
  const addresses = new Set<string>();
  for (const terminal of value.terminals) {
    if (isRecord(terminal) && terminal.state === "live" && typeof terminal.address === "string") {
      addresses.add(terminal.address);
    }
  }
  return addresses;
}

function createdBy(device: DeviceRecordView): { id: string; name: string } {
  return { id: device.id, name: device.name };
}

/** Handles task creation and record writes for control devices. */
export async function handleTaskRoutes(
  request: Request,
  context: TaskRoutesContext,
  resolveCaller: ResolveCaller,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const paths = new Set([
    "/api/tasks",
    "/api/tasks/check",
    "/api/tasks/uncheck",
    "/api/tasks/link",
    "/api/tasks/clear",
  ]);
  if (!paths.has(path)) return undefined;

  const caller = await authenticatedCaller(request, resolveCaller);
  if (caller instanceof Response) return caller;
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const body = await requestBody(request);
  if (body instanceof Response) return body;

  if (path === "/api/tasks") {
    if (!isTaskRequest(body)) return json({ error: "bad_request" }, 400);
    if (
      encoder.encode(body.text).byteLength > TASK_TEXT_MAX_BYTES ||
      body.text.includes("\0") ||
      body.text.trim().length === 0
    ) {
      return taskTextError();
    }
    try {
      const start = await context.starter.startTask(
        {
          run: body.run,
          folder: body.folder,
          space: body.space,
          task: body.text,
        },
        caller.device,
      );
      const record = await context.store.create({
        text: body.text,
        run: body.run,
        folder: body.folder,
        ...(start.space.id ? { space: { id: start.space.id } } : {}),
        ...(start.tab.id ? { tab: { id: start.tab.id } } : {}),
        placement: start.placement,
        ...(start.address === undefined ? {} : { terminal: start.address }),
        createdBy: createdBy(caller.device),
      });
      const reply: StartTaskReply = { record, start };
      return json(reply);
    } catch (error) {
      if (error instanceof StartAgentError) return startError(error);
      if (error instanceof TaskStoreError) return storeError(error);
      return json({ error: "internal_error" }, 500);
    }
  }

  if (path === "/api/tasks/check") {
    if (!isCheckRequest(body)) return json({ error: "bad_request" }, 400);
    try {
      const record = await context.store.check(
        "id" in body ? body.id : { terminal: body.terminal },
        body.turn,
        caller.device,
      );
      return json(record);
    } catch (error) {
      if (error instanceof TaskStoreError) return storeError(error);
      return json({ error: "internal_error" }, 500);
    }
  }

  if (path === "/api/tasks/uncheck") {
    if (!isUncheckRequest(body)) return json({ error: "bad_request" }, 400);
    try {
      return json(await context.store.uncheck(body.id));
    } catch (error) {
      if (error instanceof TaskStoreError) return storeError(error);
      return json({ error: "internal_error" }, 500);
    }
  }

  if (path === "/api/tasks/link") {
    if (!isLinkRequest(body)) return json({ error: "bad_request" }, 400);
    try {
      return json(await context.store.link(body.id, body.terminal));
    } catch (error) {
      if (error instanceof TaskStoreError) return storeError(error);
      return json({ error: "internal_error" }, 500);
    }
  }

  if (!isClearRequest(body)) return json({ error: "bad_request" }, 400);
  try {
    const terminals = await context.coreCall("terminal.list", {});
    const removed = await context.store.clear(body.spaceId, liveAddresses(terminals));
    return json({ removed });
  } catch (error) {
    if (error instanceof TaskStoreError) return storeError(error);
    return json({ error: "core_unavailable", message: "Can’t reach your Mac." }, 503);
  }
}
