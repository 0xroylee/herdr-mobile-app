import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import { AllowedRoots, ROOT_RESOLVE_TIMEOUT_MS } from "./roots.ts";

class ManualClock implements Clock {
  private current = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  pending(): number[] {
    return [...this.timers.values()]
      .map(({ at }) => at - this.current)
      .sort((left, right) => left - right);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      timer.callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function mappedRealPath(paths: Map<string, string>, calls: string[]) {
  return async (path: string): Promise<string> => {
    calls.push(path);
    const realPath = paths.get(path);
    if (realPath === undefined) throw new Error("ENOENT");
    return realPath;
  };
}

describe("AllowedRoots", () => {
  test("lists canonical roots once and spells a symlinked home like its root entry", async () => {
    const paths = new Map([
      ["/Users/link", "/Users/real"],
      ["/Users/real", "/Users/real"],
    ]);
    const roots = new AllowedRoots({
      home: "/Users/link",
      roots: ["/Users/real"],
      realPath: mappedRealPath(paths, []),
      clock: new ManualClock(),
    });

    await expect(roots.listing()).resolves.toEqual({
      home: "/Users/real",
      roots: ["/Users/real"],
    });
  });

  test("lists a missing root as configured and retries it on the next use", async () => {
    const paths = new Map([["/home/owner", "/home/owner"]]);
    const calls: string[] = [];
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/offline"],
      realPath: mappedRealPath(paths, calls),
      clock: new ManualClock(),
    });

    await expect(roots.listing()).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/offline"],
    });
    paths.set("/offline", "/Volumes/Work");
    await expect(roots.listing()).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/Volumes/Work"],
    });

    expect(calls.filter((path) => path === "/offline")).toHaveLength(2);
  });

  test("bounds a never-settling root, reuses its view, and adopts a late success", async () => {
    const clock = new ManualClock();
    const calls: string[] = [];
    let resolveOffline: (path: string) => void = () => {};
    const offline = new Promise<string>((resolvePath) => {
      resolveOffline = resolvePath;
    });
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/offline"],
      realPath(path) {
        calls.push(path);
        if (path === "/home/owner") return Promise.resolve(path);
        return offline;
      },
      clock,
    });

    let firstSettled = false;
    const firstListing = roots.listing().then((listing) => {
      firstSettled = true;
      return listing;
    });
    await settle();
    expect(firstSettled).toBe(false);
    expect(clock.pending()).toEqual([ROOT_RESOLVE_TIMEOUT_MS]);
    await clock.advance(ROOT_RESOLVE_TIMEOUT_MS - 1);
    expect(firstSettled).toBe(false);
    await clock.advance(1);
    await expect(firstListing).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/offline"],
    });
    expect(clock.pending()).toEqual([]);

    await expect(roots.listing()).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/offline"],
    });
    expect(calls.filter((path) => path === "/offline")).toHaveLength(1);
    expect(clock.pending()).toEqual([]);

    resolveOffline("/Volumes/Offline");
    await settle();
    await expect(roots.listing()).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/Volumes/Offline"],
    });
  });

  test("allows a matching home folder before another root settles", async () => {
    const never = new Promise<string>(() => {});
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/offline"],
      realPath: (path) => (path === "/home/owner" ? Promise.resolve(path) : never),
      clock: new ManualClock(),
    });

    await expect(roots.allows("/home/owner/project")).resolves.toBe(true);
  });

  test("returns false when every resolved root is outside the folder", async () => {
    const paths = new Map([
      ["/home/owner", "/home/owner"],
      ["/workspace", "/workspace"],
    ]);
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/workspace"],
      realPath: mappedRealPath(paths, []),
      clock: new ManualClock(),
    });

    await expect(roots.allows("/outside/project")).resolves.toBe(false);
  });

  test("returns false after a never-settling root reaches its deadline", async () => {
    const clock = new ManualClock();
    const never = new Promise<string>(() => {});
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/offline"],
      realPath: (path) => (path === "/home/owner" ? Promise.resolve(path) : never),
      clock,
    });
    const allowed = roots.allows("/outside/project");
    await settle();
    expect(clock.pending()).toEqual([ROOT_RESOLVE_TIMEOUT_MS]);

    await clock.advance(ROOT_RESOLVE_TIMEOUT_MS);
    await expect(allowed).resolves.toBe(false);
  });

  test("returns false when no root resolves", async () => {
    const roots = new AllowedRoots({
      home: "/offline-home",
      roots: ["/offline"],
      realPath: async () => {
        throw new Error("ENOENT");
      },
      clock: new ManualClock(),
    });

    await expect(roots.allows("/outside/project")).resolves.toBe(false);
  });

  test("uses path components for containment and allows a folder equal to a root", async () => {
    const paths = new Map([["/home/a", "/home/a"]]);
    const roots = new AllowedRoots({
      home: "/home/a",
      roots: [],
      realPath: mappedRealPath(paths, []),
      clock: new ManualClock(),
    });

    await expect(roots.allows("/home/ab/project")).resolves.toBe(false);
    await expect(roots.allows("/home/a")).resolves.toBe(true);
  });

  test("caches ready roots across allows calls", async () => {
    const paths = new Map([
      ["/home/owner", "/home/owner"],
      ["/workspace", "/workspace"],
    ]);
    const calls: string[] = [];
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/workspace"],
      realPath: mappedRealPath(paths, calls),
      clock: new ManualClock(),
    });

    await expect(roots.allows("/workspace/project")).resolves.toBe(true);
    await expect(roots.allows("/home/owner/project")).resolves.toBe(true);
    expect(calls).toEqual(["/home/owner", "/workspace"]);
  });

  test("adds home as a root when the configured roots omit it", async () => {
    const roots = new AllowedRoots({
      home: "/home/owner",
      roots: ["/workspace"],
      realPath: async (path) => path,
      clock: new ManualClock(),
    });

    await expect(roots.listing()).resolves.toEqual({
      home: "/home/owner",
      roots: ["/home/owner", "/workspace"],
    });
  });
});
