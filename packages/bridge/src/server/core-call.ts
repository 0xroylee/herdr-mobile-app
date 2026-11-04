import { createClient, HcRpcError, TransportClosedError } from "@herdr-mobile/hc-client";
import type { Clock } from "../prototype/deadline.ts";
import { DeadlineError, systemClock, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import { connectEnv } from "./connect-env.ts";

const CORE_CALL_TIMEOUT_MS = 10_000;

export interface CoreCallDependencies {
  runner: ProcessRunner;
  hcPath: string;
  session?: string;
  env: Record<string, string>;
  cwd: string;
  clock?: Clock;
}

export type CoreMethod = "templates.list" | "terminal.run";

/** A one-shot `hc connect` failure that did not come from a JSON-RPC error reply. */
export class HcConnectError extends Error {
  readonly kind = "spawn_failed";

  constructor(message: string) {
    super(message);
    this.name = "HcConnectError";
  }
}

interface DynamicCoreClient {
  call(method: CoreMethod, params: unknown): Promise<unknown>;
  feed(bytes: Uint8Array): void;
  end(cause?: unknown): void;
}

function collect(
  read: (onData: (bytes: Uint8Array) => void, onEnd: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => read(() => {}, resolve));
}

/** Makes one plain JSON-RPC call through a short-lived `hc connect` process. */
export async function callCore(
  dependencies: CoreCallDependencies,
  method: CoreMethod,
  params: unknown,
): Promise<unknown> {
  let child: ReturnType<ProcessRunner["spawn"]>;
  try {
    child = dependencies.runner.spawn([dependencies.hcPath, "connect"], {
      env: connectEnv(dependencies.env, { session: dependencies.session }),
      cwd: dependencies.cwd,
      stderr: "pipe",
    });
  } catch (error) {
    throw new HcConnectError(
      `could not start hc connect: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let inputClosed = false;
  const client = createClient({
    write: async (bytes) => {
      await child.write(bytes);
      if (!inputClosed) {
        inputClosed = true;
        child.closeInput();
      }
    },
  }) as unknown as DynamicCoreClient;

  let outputEnded: () => void = () => {};
  const outputClosed = new Promise<void>((resolve) => {
    outputEnded = resolve;
  });
  const stderrClosed = child.readStderr
    ? collect((onData, onEnd) => child.readStderr?.(onData, onEnd))
    : Promise.resolve();
  child.read(
    (bytes) => {
      try {
        client.feed(bytes);
      } catch (error) {
        client.end(error);
      }
    },
    () => {
      client.end(new HcConnectError("hc connect closed its output before replying"));
      outputEnded();
    },
  );

  try {
    const work = Promise.all([
      client.call(method, params),
      child.exited,
      outputClosed,
      stderrClosed,
    ]);
    const [result, exitCode] = await within(
      "hc connect",
      work,
      CORE_CALL_TIMEOUT_MS,
      dependencies.clock ?? systemClock,
      new AbortController().signal,
    );
    if (exitCode !== 0) {
      throw new HcConnectError(`hc connect exited with ${exitCode ?? "a signal"}`);
    }
    return result;
  } catch (error) {
    client.end(error);
    child.kill();
    if (error instanceof DeadlineError || error instanceof HcRpcError) throw error;
    if (error instanceof HcConnectError) throw error;
    if (error instanceof TransportClosedError) {
      throw new HcConnectError("hc connect closed before returning a response");
    }
    throw error;
  }
}
