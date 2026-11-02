import { describe, expect, test } from "bun:test";
import { runCli } from "./cli.ts";

const env = { HOME: "/Users/bridge", PATH: "/usr/bin:/bin" };

function success(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("herdr-bridge CLI", () => {
  test("prints a watch pairing link whose fragment decodes to the bridge URL and code", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const output: string[] = [];
    const result = await runCli(["pair", "--watch", "--name", "Desk phone"], {
      env,
      adminFetch: async (_socketPath, path, init) => {
        calls.push({ path, init });
        if (path === "/status") return success({ publicUrl: "https://mac.tailnet.ts.net" });
        return success({ code: "ABCDEFGH", expiresAt: 1_600_000 }, 201);
      },
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(`ERR ${text}`),
    });

    expect(result).toBe(0);
    expect(calls.map(({ path }) => path)).toEqual(["/status", "/pair-code"]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      role: "watch",
      name: "Desk phone",
    });
    const link = output[0]?.replace("Pair link: ", "");
    const parsed = new URL(link ?? "");
    const encoded = parsed.hash.slice("#pair=".length).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    expect(JSON.parse(atob(padded))).toEqual({ u: "https://mac.tailnet.ts.net", c: "ABCDEFGH" });
    expect(output[1]).toContain("█");
  });

  test("lists devices and revokes a named device over the admin request seam", async () => {
    const calls: { path: string; method: string }[] = [];
    const output: string[] = [];
    const adminFetch = async (_socketPath: string, path: string, init: RequestInit = {}) => {
      calls.push({ path, method: init.method ?? "GET" });
      return path === "/devices"
        ? success([{ id: "device-1", name: "Phone" }])
        : new Response(null, { status: 204 });
    };

    expect(
      await runCli(["devices"], { env, adminFetch, stdout: (text) => output.push(text) }),
    ).toBe(0);
    expect(output[0]).toContain("device-1");
    expect(
      await runCli(["devices", "revoke", "device-1"], {
        env,
        adminFetch,
        stdout: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(calls).toEqual([
      { path: "/devices", method: "GET" },
      { path: "/devices/device-1", method: "DELETE" },
    ]);
  });

  test("prints help and rejects bad pair options", async () => {
    const help: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => help.push(text) })).toBe(0);
    expect(help[0]).toContain("herdr-bridge serve");

    const errors: string[] = [];
    expect(await runCli(["pair", "--invalid"], { env, stderr: (text) => errors.push(text) })).toBe(
      1,
    );
    expect(errors[0]).toContain("unknown pair option");
  });
});
