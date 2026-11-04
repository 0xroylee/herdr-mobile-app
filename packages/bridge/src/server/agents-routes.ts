import type { StartAgentRequest } from "@herdr-mobile/protocol";
import { type AppCliContext, authenticatedCaller, requestBody } from "./app-cli.ts";
import { type AgentStarter, StartAgentError } from "./start-agent.ts";

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

function isStartAgentRequest(value: unknown): value is StartAgentRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["run", "folder", "space", "task"]) ||
    typeof value.folder !== "string" ||
    !isRecord(value.run) ||
    !isRecord(value.space) ||
    (value.task !== undefined && typeof value.task !== "string")
  ) {
    return false;
  }

  const runValid =
    (value.run.kind === "program" &&
      typeof value.run.id === "string" &&
      hasOnlyKeys(value.run, ["kind", "id"])) ||
    (value.run.kind === "template" &&
      typeof value.run.name === "string" &&
      hasOnlyKeys(value.run, ["kind", "name"]));
  const spaceValid =
    (value.space.kind === "existing" &&
      typeof value.space.id === "string" &&
      hasOnlyKeys(value.space, ["kind", "id"])) ||
    (value.space.kind === "new" &&
      (value.space.name === undefined || typeof value.space.name === "string") &&
      hasOnlyKeys(value.space, ["kind", "name"]));
  return runValid && spaceValid;
}

function startError(error: StartAgentError): Response {
  return json(
    {
      error: error.code,
      message: error.message,
      ...(error.kind === undefined ? {} : { kind: error.kind }),
    },
    error.status,
  );
}

/** Handles the agent catalog and start routes after the existing identity and token checks. */
export async function handleAgentsRoutes(
  request: Request,
  context: AppCliContext,
  starter: AgentStarter,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/agents/catalog" && path !== "/api/agents/start") return undefined;

  const caller = await authenticatedCaller(request, context);
  if (caller instanceof Response) return caller;

  if (path === "/api/agents/catalog") {
    if (request.method !== "GET")
      return json({ error: "method_not_allowed", message: "Use GET." }, 405);
    try {
      return json(await starter.catalog());
    } catch (error) {
      if (error instanceof StartAgentError) return startError(error);
      return json({ error: "internal_error" }, 500);
    }
  }

  if (request.method !== "POST")
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (!isStartAgentRequest(body)) return json({ error: "bad_request" }, 400);

  try {
    return json(await starter.start(body, caller));
  } catch (error) {
    if (error instanceof StartAgentError) return startError(error);
    return json({ error: "internal_error" }, 500);
  }
}
