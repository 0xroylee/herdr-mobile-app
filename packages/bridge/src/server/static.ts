import { readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

/** Hides static asset filesystem access; `nodeStaticFs` is the production adapter and `FakeStaticFs` is the test adapter. */
export interface StaticFs {
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
}

export const nodeStaticFs: StaticFs = { realpath, readFile };

const BASE_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
};

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function within(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep))
  );
}

/** Returns a lexical path under `webDir`, or undefined for an unsafe URL path. */
export function safePathJoin(webDir: string, pathname: string): string | undefined {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    /%(?:2f|5c|00)/iu.test(pathname)
  ) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return undefined;
  }

  const root = resolve(webDir);
  const target = resolve(root, `.${decoded}`);
  return within(root, target) ? target : undefined;
}

function responseHeaders(path: string, cacheControl: string): Headers {
  const headers = new Headers(BASE_HEADERS);
  headers.set("Cache-Control", cacheControl);
  headers.set(
    "Content-Type",
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
  );
  return headers;
}

function errorResponse(status: number, message: string): Response {
  const headers = new Headers(BASE_HEADERS);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(message, { status, headers });
}

async function readInsideRoot(
  fs: StaticFs,
  root: string,
  candidate: string,
): Promise<{ bytes: Uint8Array; path: string } | "outside" | undefined> {
  try {
    const actual = await fs.realpath(candidate);
    if (!within(root, actual)) return "outside";
    return { bytes: await fs.readFile(actual), path: actual };
  } catch {
    return undefined;
  }
}

/** Serves one web asset with an SPA fallback, without following paths outside the build root. */
export async function serveStatic(
  request: Request,
  webDir: string,
  fs: StaticFs = nodeStaticFs,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed");
  }

  const candidate = safePathJoin(webDir, new URL(request.url).pathname);
  if (!candidate) return errorResponse(400, "bad_path");

  let root: string;
  try {
    root = await fs.realpath(resolve(webDir));
  } catch {
    return errorResponse(404, "not_found");
  }

  const isIndex = candidate === safePathJoin(webDir, "/index.html");
  const requested = await readInsideRoot(fs, root, candidate);
  if (requested === "outside") return errorResponse(404, "not_found");
  if (requested) {
    const headers = responseHeaders(requested.path, isIndex ? "no-cache" : "public, max-age=3600");
    return new Response(request.method === "HEAD" ? null : requested.bytes, { headers });
  }

  const indexPath = resolve(root, "index.html");
  const fallback = await readInsideRoot(fs, root, indexPath);
  if (!fallback || fallback === "outside") return errorResponse(404, "not_found");
  const headers = responseHeaders(fallback.path, "no-cache");
  return new Response(request.method === "HEAD" ? null : fallback.bytes, { headers });
}
