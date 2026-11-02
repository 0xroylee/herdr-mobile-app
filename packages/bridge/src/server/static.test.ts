import { describe, expect, test } from "bun:test";
import type { StaticFs } from "./static.ts";
import { safePathJoin, serveStatic } from "./static.ts";

class FakeFs implements StaticFs {
  readonly files = new Map<string, Uint8Array>();
  readonly links = new Map<string, string>();

  async realpath(path: string): Promise<string> {
    if (path === "/web") return "/web";
    const actual = this.links.get(path) ?? path;
    if (!this.files.has(actual)) throw new Error("missing");
    return actual;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const contents = this.files.get(path);
    if (!contents) throw new Error("missing");
    return contents;
  }
}

function request(path: string, method = "GET"): Request {
  return new Request(`http://bridge${path}`, { method });
}

const encoder = new TextEncoder();

describe("static web serving", () => {
  test("joins only safe paths within the web directory", () => {
    expect(safePathJoin("/web", "/assets/app.js")).toBe("/web/assets/app.js");
    for (const path of [
      "../secret",
      "/../secret",
      "/%2e%2e/secret",
      "/assets%2fsecret.js",
      "/assets%5Csecret.js",
      "/nul%00file",
      "//etc/passwd",
      "/assets\\secret.js",
    ]) {
      expect(safePathJoin("/web", path)).toBeUndefined();
    }
  });

  test("serves assets and falls back to index.html for client routes", async () => {
    const fs = new FakeFs();
    fs.files.set("/web/index.html", encoder.encode("<main>app</main>"));
    fs.files.set("/web/assets/app.js", encoder.encode("export {};"));

    const asset = await serveStatic(request("/assets/app.js"), "/web", fs);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(asset.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(asset.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await asset.text()).toBe("export {};");

    const route = await serveStatic(request("/spaces/current"), "/web", fs);
    expect(route.status).toBe(200);
    expect(route.headers.get("Cache-Control")).toBe("no-cache");
    expect(await route.text()).toBe("<main>app</main>");
  });

  test("does not follow a symlink outside the web directory", async () => {
    const fs = new FakeFs();
    fs.files.set("/web/index.html", encoder.encode("index"));
    fs.files.set("/private/secret.txt", encoder.encode("secret"));
    fs.links.set("/web/secret.txt", "/private/secret.txt");

    const response = await serveStatic(request("/secret.txt"), "/web", fs);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not_found");
  });

  test("rejects unsafe request paths and non-read methods", async () => {
    const fs = new FakeFs();
    fs.files.set("/web/index.html", encoder.encode("index"));
    expect((await serveStatic(request("/%2Fetc/passwd"), "/web", fs)).status).toBe(400);
    expect((await serveStatic(request("/asset", "POST"), "/web", fs)).status).toBe(405);
    const head = await serveStatic(request("/", "HEAD"), "/web", fs);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
