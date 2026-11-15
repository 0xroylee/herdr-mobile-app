/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { StartAgentRequest, StartTaskRequest } from "@herdr-mobile/protocol";
import { type BridgeApiError, type BridgeFetch, createBridgeApi } from "./bridge-api.ts";

describe("bridge API", () => {
  test("uses the bridge paths, bearer token and request payloads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: BridgeFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/pair")) {
        return Response.json({
          deviceId: "device-1",
          token: "one-time-token",
          role: "control",
          machine: { id: "machine-1", name: "Mac" },
        });
      }
      if (String(input).endsWith("/api/devices")) {
        return Response.json([
          { id: "device-1", name: "Phone", role: "control", createdAt: 1, lastSeenAt: null },
        ]);
      }
      if (String(input).includes("/api/devices/")) return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    };
    const api = createBridgeApi(fetcher);

    const pair = await api.pair("https://mac.tailnet.ts.net/", { code: "ABCD2345", name: "Phone" });
    await api.health("https://mac.tailnet.ts.net", "token");
    const devices = await api.devices("https://mac.tailnet.ts.net", "token");
    await api.revoke("https://mac.tailnet.ts.net", "token", "self");
    await api.appLs("https://mac.tailnet.ts.net", "token");
    await api.appDo("https://mac.tailnet.ts.net", "token", "space.new", { name: "Docs" });

    expect(pair.token).toBe("one-time-token");
    expect(devices[0]?.id).toBe("device-1");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://mac.tailnet.ts.net/api/pair",
      "https://mac.tailnet.ts.net/api/health",
      "https://mac.tailnet.ts.net/api/devices",
      "https://mac.tailnet.ts.net/api/devices/self",
      "https://mac.tailnet.ts.net/api/app/ls",
      "https://mac.tailnet.ts.net/api/app/do",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBeNull();
    expect(new Headers(calls[1]?.init.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "ABCD2345", name: "Phone" });
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({
      action: "space.new",
      args: { name: "Docs" },
    });
  });

  test("surfaces structured HTTP errors", async () => {
    const api = createBridgeApi(async () =>
      Response.json(
        { error: "herdr_not_running", message: "Herdr isn't running on your Mac" },
        { status: 409 },
      ),
    );

    await expect(api.appLs("https://mac.tailnet.ts.net", "token")).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 409,
      code: "herdr_not_running",
      message: "Herdr isn't running on your Mac",
    } satisfies Partial<BridgeApiError>);
  });

  test("loads the agent catalog and starts an agent with the bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: BridgeFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/agents/catalog")) {
        return Response.json({
          programs: ["claude", "codex"],
          templates: [{ name: "review", description: "Review a change" }],
          roots: ["/Users/roy"],
          home: "/Users/roy",
          windowOpen: true,
        });
      }
      return Response.json({
        placement: "window",
        address: "t1",
        space: { id: "sp1", isNew: false },
        tab: { id: "tb1", isNew: true },
      });
    };
    const api = createBridgeApi(fetcher);
    const request: StartAgentRequest = {
      run: { kind: "template", name: "review" },
      folder: "/Users/roy/project",
      space: { kind: "existing", id: "sp1" },
      task: "Review this change",
    };

    const catalog = await api.agentCatalog("https://mac.tailnet.ts.net/", "token");
    const reply = await api.startAgent("https://mac.tailnet.ts.net", "token", request);

    expect(catalog.templates[0]?.name).toBe("review");
    expect(reply.address).toBe("t1");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://mac.tailnet.ts.net/api/agents/catalog",
      "https://mac.tailnet.ts.net/api/agents/start",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer token");
    expect(new Headers(calls[1]?.init.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(request);
  });

  test("rejects invalid agent catalog and start replies", async () => {
    const invalidCatalog = createBridgeApi(async () => Response.json({ programs: ["claude"] }));
    await expect(invalidCatalog.agentCatalog("https://mac", "token")).rejects.toThrow(
      "invalid agent catalog",
    );

    const invalidReply = createBridgeApi(async () =>
      Response.json({ placement: "elsewhere", space: { id: "sp1", isNew: false } }),
    );
    await expect(
      invalidReply.startAgent("https://mac", "token", {
        run: { kind: "program", id: "claude" },
        folder: "/repo",
        space: { kind: "new" },
      }),
    ).rejects.toThrow("invalid start reply");
  });

  test("surfaces structured start errors from the bridge", async () => {
    const api = createBridgeApi(async () =>
      Response.json({ error: "folder_missing", message: "Folder does not exist" }, { status: 422 }),
    );

    await expect(
      api.startAgent("https://mac", "token", {
        run: { kind: "program", id: "claude" },
        folder: "/repo",
        space: { kind: "new" },
      }),
    ).rejects.toMatchObject({ code: "folder_missing", message: "Folder does not exist" });
  });

  test("uses task routes, bearer auth and the protocol request bodies", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const taskId = `tk${"a".repeat(32)}`;
    const record = {
      id: taskId,
      origin: "phone",
      text: "Review the change",
      createdAt: 12,
    } as const;
    const start = {
      placement: "core",
      address: "t7",
      space: { id: "space-1", isNew: false },
      tab: { id: "tab-1", isNew: true },
    } as const;
    const fetcher: BridgeFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return String(input).endsWith("/api/tasks")
        ? Response.json({ record, start })
        : Response.json({ ok: true });
    };
    const api = createBridgeApi(fetcher);
    const request: StartTaskRequest = {
      text: "Review the change",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { kind: "existing", id: "space-1" },
    };

    await expect(api.startTask("https://mac.test/", "token", request)).resolves.toEqual({
      record,
      start,
    });
    await api.checkTask("https://mac.test", "token", { id: taskId, turn: 2 });
    await api.uncheckTask("https://mac.test", "token", { id: taskId });
    await api.linkTask("https://mac.test", "token", { id: taskId, terminal: "t7" });
    await api.clearTasks("https://mac.test", "token", { spaceId: "space-1" });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://mac.test/api/tasks",
      "https://mac.test/api/tasks/check",
      "https://mac.test/api/tasks/uncheck",
      "https://mac.test/api/tasks/link",
      "https://mac.test/api/tasks/clear",
    ]);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer token");
    }
    expect(calls.map(({ init }) => JSON.parse(String(init.body)))).toEqual([
      request,
      { id: taskId, turn: 2 },
      { id: taskId },
      { id: taskId, terminal: "t7" },
      { spaceId: "space-1" },
    ]);
  });

  test("preserves structured task route errors and validates task start replies", async () => {
    const failedApi = createBridgeApi(async () =>
      Response.json(
        { error: "task_not_allowed", message: "Write the task as a sentence." },
        { status: 422 },
      ),
    );
    const request: StartTaskRequest = {
      text: "oneword",
      run: { kind: "program", id: "claude" },
      folder: "/repo",
      space: { kind: "existing", id: "space-1" },
    };

    await expect(failedApi.startTask("https://mac.test", "token", request)).rejects.toMatchObject({
      name: "BridgeApiError",
      status: 422,
      code: "task_not_allowed",
      message: "Write the task as a sentence.",
    });

    const invalidApi = createBridgeApi(async () => Response.json({ record: {}, start: {} }));
    await expect(invalidApi.startTask("https://mac.test", "token", request)).rejects.toThrow(
      "invalid task reply",
    );
  });
});
