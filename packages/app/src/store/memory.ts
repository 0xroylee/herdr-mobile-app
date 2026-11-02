import type { Secrets } from "./secrets.ts";
import type { Storage } from "./storage.ts";

/** Map-backed persistence adapter for tests and in-memory previews. */
export function createMemoryStorage(seed: Iterable<readonly [string, string]> = []): Storage {
  const values = new Map(seed);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** Map-backed secret adapter that remains independent from key/value persistence. */
export function createMemorySecrets(seed: Iterable<readonly [string, string]> = []): Secrets {
  const values = new Map(seed);
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}
