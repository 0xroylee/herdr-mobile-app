import { describe, expect, test } from "bun:test";
import { connectEnv } from "./connect-env.ts";

describe("connectEnv", () => {
  test("passes only path, home, locale and the configured session", () => {
    const env = connectEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/example",
        LANG: "en_US.UTF-8",
        LANGUAGE: "en_US:en",
        LC_ALL: "en_US.UTF-8",
        LC_MESSAGES: "en_US.UTF-8",
        HC_SESSION: "parent-session",
        HC_SOCKET: "/tmp/core.sock",
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/tmp/terminal.sock",
        HC_SCOPE: "parent-scope",
        HC_RUNTIME: "/tmp/runtime",
        XDG_RUNTIME_DIR: "/tmp/xdg",
        SECRET: "not forwarded",
      },
      { session: "configured-session" },
    );

    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      LANGUAGE: "en_US:en",
      LC_ALL: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      HC_SESSION: "configured-session",
    });
  });

  test("does not inherit the parent's HC_SESSION when no session is configured", () => {
    expect(connectEnv({ PATH: "/bin", HC_SESSION: "parent-session" })).toEqual({ PATH: "/bin" });
  });
});
