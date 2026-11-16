import { describe, expect, test } from "bun:test";
import type { TaskRecord, TasksDocument } from "@herdr-mobile/protocol";
import type { SecureSession } from "@herdr-mobile/secure-channel";
import type { ProcessRunner } from "../prototype/process.ts";
import type { TaskRoutesContext } from "../tasks/task-routes.ts";
import type { TaskCoreCaller } from "../tasks/task-store.ts";
import { TaskStore } from "../tasks/task-store.ts";
import type { AppCliContext } from "./app-cli.ts";
import { createChannelApi } from "./channel-api.ts";
import type { ApiContext } from "./routes.ts";
import { dispatchApi } from "./routes.ts";
import { AgentStarter } from "./start-agent.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEVICE = {
  id: "device-1",
  name: "Phone",
  role: "control" as const,
  createdAt: 0,
  lastSeenAt: null,
};

class FakeSession implements SecureSession {
  readonly sent: Array<{ kind: "text" | "binary"; bytes: Uint8Array }> = [];
  readonly closed = new Promise<{ code: number; reason: string }>(() => {});
  closeCall: { code: number; reason: string } | undefined;
  send(kind: "text" | "binary", data: Uint8Array): void {
    this.sent.push({ kind, bytes: data.slice() });
  }
  onRecord(): void {}
  close(code: number, reason: string): void {
    this.closeCall = { code, reason };
  }
  get handshakeHash(): Uint8Array {
    return new Uint8Array(32);
  }
}

const WATCH_DEVICE = { ...DEVICE, id: "device-watch", role: "watch" as const };

function requestRecord(
  id: number,
  path = "/api/health",
  method = "GET",
  body?: string,
): Uint8Array {
  return encoder.encode(
    JSON.stringify({ t: "req", id, method, path, ...(body === undefined ? {} : { body }) }),
  );
}

function responses(session: FakeSession): unknown[] {
  return session.sent.map(({ bytes }) => JSON.parse(decoder.decode(bytes)) as unknown);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index++) await Promise.resolve();
}

describe("channel API multiplexing", () => {
  test("limits in-flight requests to eight and returns 429 to the ninth", async () => {
    const session = new FakeSession();
    const resolvers: Array<(response: Response) => void> = [];
    const dispatch = () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    const api = createChannelApi(session, DEVICE, dispatch);

    for (let id = 1; id <= 9; id++) api.receive(requestRecord(id));
    await settle();
    expect(resolvers).toHaveLength(8);
    expect(responses(session)).toContainEqual({
      t: "res",
      id: 9,
      status: 429,
      body: JSON.stringify({ error: "too_many_requests" }),
    });

    for (const resolve of resolvers) resolve(new Response("ok", { status: 200 }));
    await settle();
    expect(responses(session)).toHaveLength(9);
  });

  test("rejects pair and non-API paths and caps request bodies at 64 KiB", async () => {
    const session = new FakeSession();
    let dispatched = 0;
    const api = createChannelApi(session, DEVICE, async () => {
      dispatched++;
      return new Response("ok");
    });

    api.receive(requestRecord(1, "/api/pair", "POST", "{}"));
    api.receive(requestRecord(2, "/not-api"));
    api.receive(requestRecord(3, "/api/health", "POST", "x".repeat(64 * 1024 + 1)));
    await settle();

    expect(dispatched).toBe(0);
    expect(responses(session)).toEqual([
      { t: "res", id: 1, status: 404, body: JSON.stringify({ error: "not_found" }) },
      { t: "res", id: 2, status: 404, body: JSON.stringify({ error: "not_found" }) },
      { t: "res", id: 3, status: 413, body: JSON.stringify({ error: "body_too_large" }) },
    ]);
  });

  test("dispatches real task routes over the channel and rejects a watch device", async () => {
    const id = `tk${"a".repeat(32)}`;
    let document: TasksDocument = {
      v: 1,
      tasks: {
        [id]: {
          id,
          origin: "phone",
          text: "Review this change",
          run: { kind: "program", id: "claude" },
          folder: "/repo",
          terminal: "t12",
          createdAt: 1,
        } satisfies TaskRecord,
      },
    };
    let version = 1;
    const coreCall: TaskCoreCaller = async (method, params) => {
      if (method === "doc.get") return { value: document, version };
      if (method === "terminal.list") return { terminals: [] };
      if (method === "doc.set") {
        const input = params as { value: TasksDocument; version: number };
        if (input.version !== version) throw new Error("unexpected version conflict");
        document = structuredClone(input.value);
        version += 1;
        return { version };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const store = await TaskStore.open(coreCall);
    const runner: ProcessRunner = {
      spawn: () => {
        throw new Error("task check does not spawn processes");
      },
    };
    const starter = new AgentStarter({
      runner,
      programs: ["claude", "codex"],
      roots: ["/"],
      home: "/",
      herdrAppPath: "herdr-app",
      hcPath: "hc",
      env: {},
      cwd: "/",
      coreCall,
      statFs: {
        async realPath(path) {
          return path;
        },
        async stat() {
          return { isDirectory: () => true };
        },
      },
    });
    const taskRoutes: TaskRoutesContext = { starter, store, coreCall };
    const appCli: AppCliContext = { runner, env: {}, cwd: "/", herdrAppPath: "herdr-app" };
    const sharedDispatch = (request: Request, resolveCaller: Parameters<typeof dispatchApi>[1]) =>
      dispatchApi(request, resolveCaller, {
        api: {} as ApiContext,
        appCli,
        agentStarter: starter,
        taskRoutes,
      });
    const controlSession = new FakeSession();
    const controlApi = createChannelApi(controlSession, DEVICE, sharedDispatch);
    controlApi.receive(
      requestRecord(4, "/api/tasks/check", "POST", JSON.stringify({ id, turn: 2 })),
    );
    await settle();

    const controlResponses = responses(controlSession) as Array<{
      t: string;
      id: number;
      status: number;
      body?: string;
    }>;
    expect(controlResponses).toHaveLength(1);
    expect(controlResponses[0]).toMatchObject({ t: "res", id: 4, status: 200 });
    expect(JSON.parse(controlResponses[0]?.body ?? "{}")).toMatchObject({
      id,
      checkedTurn: 2,
      checkedBy: { deviceId: DEVICE.id, deviceName: DEVICE.name },
    });
    expect(document.tasks[id]?.checkedTurn).toBe(2);

    const confirmed = structuredClone(document);
    const watchSession = new FakeSession();
    const watchApi = createChannelApi(watchSession, WATCH_DEVICE, sharedDispatch);
    watchApi.receive(requestRecord(5, "/api/tasks/check", "POST", JSON.stringify({ id, turn: 3 })));
    await settle();

    expect(responses(watchSession)).toEqual([
      { t: "res", id: 5, status: 403, body: JSON.stringify({ error: "forbidden" }) },
    ]);
    expect(document).toEqual(confirmed);
  });

  test("ignores unknown channel control message types", () => {
    const session = new FakeSession();
    let dispatched = 0;
    const api = createChannelApi(session, DEVICE, async () => {
      dispatched++;
      return undefined;
    });
    api.receive(encoder.encode(JSON.stringify({ t: "ping", at: 1 })));
    expect(dispatched).toBe(0);
    expect(session.closeCall).toBeUndefined();
    expect(session.sent).toHaveLength(0);
  });

  test("sends a successful revoke response before notifying the listener to close sessions", async () => {
    const session = new FakeSession();
    let revoked = false;
    const api = createChannelApi(
      session,
      DEVICE,
      async () => new Response(null, { status: 204 }),
      () => {
        revoked = true;
      },
    );
    api.receive(requestRecord(7, "/api/devices/self", "DELETE"));
    await settle();

    expect(responses(session)).toEqual([{ t: "res", id: 7, status: 204 }]);
    expect(revoked).toBe(true);
  });

  test("reconciles normalized device deletion requests after dispatch failures", async () => {
    for (const method of ["delete", "dElEtE"]) {
      const session = new FakeSession();
      let reconciliations = 0;
      const api = createChannelApi(
        session,
        DEVICE,
        async (request) => {
          expect(request.method).toBe("DELETE");
          throw new Error("persistence failed");
        },
        () => {
          reconciliations++;
        },
      );

      api.receive(requestRecord(8, "/api/devices/self", method));
      await settle();

      expect(responses(session)).toEqual([
        { t: "res", id: 8, status: 500, body: JSON.stringify({ error: "internal_error" }) },
      ]);
      expect(reconciliations).toBe(1);
    }
  });
});
