import type { Role } from "@herdr-mobile/protocol";
import { BRIDGE_WS_CLOSE_CODES } from "@herdr-mobile/protocol";
import { type Clock, DeadlineError, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";
import type { Env } from "../prototype/scratch.ts";
import { connectEnv } from "./connect-env.ts";
import { createGate } from "./gate.ts";
import type { Socket } from "./socket.ts";

export const CONNECT_SHUTDOWN_MS = 5_000;

export interface StartSessionOptions {
  socket: Socket;
  runner: ProcessRunner;
  clock: Clock;
  env: Env;
  role: Role;
  session?: string;
}

/** Owns one `hc connect` child and forwards its bytes through the role gate. */
export function startSession(options: StartSessionOptions): void {
  const child = options.runner.spawn(["hc", "connect"], {
    env: connectEnv(options.env, { session: options.session }),
    cwd: options.env.HOME ?? "/",
  });
  const gate = createGate(options.role);
  let socketEnded = false;
  let childExited = false;
  let shutdownStarted = false;
  let writeQueue = Promise.resolve();
  let inputClosed = false;

  const closeInput = () => {
    if (inputClosed) return;
    inputClosed = true;
    child.closeInput();
  };

  const shutdownChild = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    closeInput();
    void within(
      "hc connect shutdown",
      child.exited,
      CONNECT_SHUTDOWN_MS,
      options.clock,
      new AbortController().signal,
    ).catch((error: unknown) => {
      if (error instanceof DeadlineError && !childExited) child.kill();
    });
  };

  const stopSocket = (code: number, reason: string) => {
    if (socketEnded) return;
    socketEnded = true;
    try {
      options.socket.close(code, reason);
    } finally {
      shutdownChild();
    }
  };

  const failSession = () => stopSocket(BRIDGE_WS_CLOSE_CODES.CHILD_EXITED, "hc connect failed");

  options.socket.onMessage((bytes) => {
    if (socketEnded) return;
    try {
      const { toCore, toPhone } = gate.fromPhone(bytes);
      if (toPhone.length > 0) options.socket.send(toPhone);
      if (toCore.length > 0) {
        writeQueue = writeQueue
          .then(() => {
            if (socketEnded) return;
            return child.write(toCore);
          })
          .then(() => {}, failSession);
      }
    } catch {
      failSession();
    }
  });

  options.socket.onClose(() => {
    if (socketEnded) return;
    socketEnded = true;
    shutdownChild();
  });

  child.read(
    (bytes) => {
      if (socketEnded) return;
      try {
        const { toPhone } = gate.fromCore(bytes);
        if (toPhone.length > 0) options.socket.send(toPhone);
      } catch {
        failSession();
      }
    },
    () => {},
  );

  void child.exited.then(() => {
    childExited = true;
    if (!socketEnded) stopSocket(BRIDGE_WS_CLOSE_CODES.CHILD_EXITED, "hc connect exited");
  }, failSession);
}
