import { relative, resolve, sep } from "node:path";
import type { Clock } from "../prototype/deadline.ts";
import { within } from "../prototype/deadline.ts";

export const ROOT_RESOLVE_TIMEOUT_MS = 5_000;

export interface RootsListing {
  home: string;
  roots: string[];
}

interface IdleRoot {
  state: "idle";
}

interface ResolvingRoot {
  state: "resolving";
  view: Promise<string | undefined>;
}

interface ReadyRoot {
  state: "ready";
  realPath: string;
}

type RootState = IdleRoot | ResolvingRoot | ReadyRoot;

function isUnder(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

/** Resolves and caches allowed roots without letting a missing volume block bridge work. */
export class AllowedRoots {
  private readonly home: string;
  private readonly roots: string[];
  private readonly realPath: (path: string) => Promise<string>;
  private readonly clock: Clock;
  private readonly states = new Map<string, RootState>();

  constructor(options: {
    home: string;
    roots: readonly string[];
    realPath: (path: string) => Promise<string>;
    clock: Clock;
  }) {
    this.home = resolve(options.home);
    this.roots = [...new Set([this.home, ...options.roots.map((root) => resolve(root))])];
    this.realPath = options.realPath;
    this.clock = options.clock;
  }

  async listing(): Promise<RootsListing> {
    const spellings = await Promise.all(
      this.roots.map(async (root) => (await this.resolveRoot(root)) ?? root),
    );
    const roots = [...new Set(spellings)];
    return { home: spellings[0] ?? this.home, roots };
  }

  async allows(realFolder: string): Promise<boolean> {
    const pending = this.roots.map((root) => this.resolveRoot(root));
    const unresolved = new Set(pending.map((_promise, index) => index));

    while (unresolved.size > 0) {
      const result = await Promise.race(
        [...unresolved].map(async (index) => ({
          index,
          realPath: await (pending[index] as Promise<string | undefined>),
        })),
      );
      unresolved.delete(result.index);
      if (result.realPath !== undefined && isUnder(result.realPath, realFolder)) return true;
    }

    return false;
  }

  private resolveRoot(root: string): Promise<string | undefined> {
    const current = this.states.get(root);
    if (current?.state === "ready") return Promise.resolve(current.realPath);
    if (current?.state === "resolving") return current.view;

    const raw = Promise.resolve()
      .then(() => this.realPath(root))
      .then(
        (path) => {
          const realPath = resolve(path);
          this.states.set(root, { state: "ready", realPath });
          return realPath;
        },
        (error: unknown) => {
          this.states.set(root, { state: "idle" });
          throw error;
        },
      );
    const view = within(
      "allowed root resolution",
      raw,
      ROOT_RESOLVE_TIMEOUT_MS,
      this.clock,
      new AbortController().signal,
    ).then(
      (path) => path,
      () => undefined,
    );
    this.states.set(root, { state: "resolving", view });
    return view;
  }
}
