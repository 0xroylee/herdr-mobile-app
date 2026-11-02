// Child processes the prototype owns. Only children it spawned itself ever get closed or killed:
// no process scans, no pids from anywhere else.

export interface OwnedProcess {
  /** Writes to its stdin. */
  write(bytes: Uint8Array): void | Promise<void>;
  /** Closes its stdin. `hc connect` then disconnects and exits. */
  closeInput(): void;
  /** Hands each chunk of its stdout to `onData`, then calls `onEnd` once stdout closes. */
  read(onData: (bytes: Uint8Array) => void, onEnd: () => void): void;
  /** Hands each chunk of piped stderr to `onData`; present when spawn requested stderr piping. */
  readStderr?(onData: (bytes: Uint8Array) => void, onEnd: () => void): void;
  /** Its exit code once it has exited; null when a signal ended it. */
  readonly exited: Promise<number | null>;
  /** Sends it SIGTERM. */
  kill(): void;
}

export interface ProcessRunner {
  spawn(
    argv: string[],
    options: { env: Record<string, string>; cwd: string; stderr?: "pipe" },
  ): OwnedProcess;
}

export const bunRunner: ProcessRunner = {
  spawn(argv, { env, cwd, stderr }) {
    const child = Bun.spawn(argv, {
      env,
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: stderr === "pipe" ? "pipe" : "inherit",
    });
    let open = true;
    const owned: OwnedProcess = {
      write(bytes) {
        child.stdin.write(bytes);
        return Promise.resolve(child.stdin.flush()).then(() => {});
      },
      closeInput() {
        if (!open) return;
        open = false;
        Promise.resolve(child.stdin.end()).catch(() => {
          // Already gone: the child has exited.
        });
      },
      read(onData, onEnd) {
        void (async () => {
          try {
            for await (const chunk of child.stdout) onData(chunk);
          } finally {
            onEnd();
          }
        })();
      },
      exited: child.exited.then(() => child.exitCode),
      kill() {
        child.kill("SIGTERM");
      },
    };
    if (stderr === "pipe") {
      owned.readStderr = (onData, onEnd) => {
        void (async () => {
          try {
            if (child.stderr) {
              for await (const chunk of child.stderr) onData(chunk);
            }
          } finally {
            onEnd();
          }
        })();
      };
    }
    return owned;
  },
};
