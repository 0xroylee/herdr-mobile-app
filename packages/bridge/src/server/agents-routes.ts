import { authenticatedCaller } from "./app-cli.ts";
import type { ResolveCaller } from "./caller.ts";
import { type AgentStarter, StartAgentError } from "./start-agent.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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

/** Handles the agent catalog route for the resolved device caller. */
export async function handleAgentsRoutes(
  request: Request,
  starter: AgentStarter,
  resolveCaller: ResolveCaller,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/agents/catalog") return undefined;

  const caller = await authenticatedCaller(request, resolveCaller);
  if (caller instanceof Response) return caller;

  if (request.method !== "GET")
    return json({ error: "method_not_allowed", message: "Use GET." }, 405);

  try {
    return json(await starter.catalog());
  } catch (error) {
    if (error instanceof StartAgentError) return startError(error);
    return json({ error: "internal_error" }, 500);
  }
}
