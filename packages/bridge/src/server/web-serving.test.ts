import { describe, expect, test } from "bun:test";
import type { AppCliContext } from "./app-cli.ts";
import { parseServeFlags } from "./config.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
import { PairingCodes } from "./pairing.ts";
import { createBridgeFetchHandler } from "./serve.ts";
import type { StaticFs } from "./static.ts";

class FakeStoreFs implements StoreFs {
  async readFile(): Promise<string | undefined> {
    return undefined;
  }
  async mkdir(): Promise<void> {}
  async writeFile(): Promise<void> {}
  async rename(): Promise<void> {}
  async unlink(): Promise<void> {}
}

class FakeStaticFs implements StaticFs {
  readonly reads: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async realpath(path: string): Promise<string> {
    if (path === this.root || this.files.has(path)) return path;
    throw new Error("missing file");
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    const contents = this.files.get(path);
    if (!contents) throw new Error("missing file");
    return contents;
  }
}

class NeverSpawnRunner {
  spawn(): never {
    throw new Error("unexpected child process");
  }
}

describe("bridge web build serving", () => {
  test("serves index.html from the parsed --web directory at / after identity passes", async () => {
    const parsed = parseServeFlags(["--owner", "owner@example.com", "--web", "./public"], "/repo");
    const indexPath = `${parsed.webDir}/index.html`;
    const staticFs = new FakeStaticFs(parsed.webDir);
    staticFs.files.set(indexPath, new TextEncoder().encode("<!doctype html><main>Herdr</main>"));

    const identity = { ownerLogin: "owner@example.com" };
    const devices = await DeviceStore.open(new FakeStoreFs(), "/state/devices.json");
    const runner = new NeverSpawnRunner();
    const appCli: AppCliContext = {
      identity,
      devices,
      runner,
      env: {},
      cwd: "/repo",
      herdrAppPath: "herdr-app",
    };
    const handler = createBridgeFetchHandler({
      api: {
        identity,
        devices,
        pairing: new PairingCodes(),
        machine: { id: "mac-1", name: "Mac" },
      },
      appCli,
      identity,
      webDir: parsed.webDir,
      staticFs,
    });

    const response = await handler(
      new Request("http://bridge/", {
        headers: { "Tailscale-User-Login": "owner@example.com" },
      }),
    );

    expect(parsed.webDir).toBe("/repo/public");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response?.text()).toBe("<!doctype html><main>Herdr</main>");
    expect(staticFs.reads).toEqual([parsed.webDir, indexPath]);
  });
});
