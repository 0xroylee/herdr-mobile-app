import type { ReadResult } from "@herdr-mobile/protocol";
import type { ConnectionManager } from "./connection.ts";

export interface ScreenTextKey {
  turn: number | undefined;
  state: string | undefined;
}

export interface ScreenText {
  read(address: string, key: ScreenTextKey): Promise<readonly string[]>;
  invalidate(address: string): void;
}

/** Cache terminal screen rows per address, turn and status state while sharing in-flight reads. */
export function createScreenText(manager: Pick<ConnectionManager, "call">): ScreenText {
  const cache = new Map<string, Map<string, Promise<readonly string[]>>>();

  return {
    read(address, key) {
      let addressCache = cache.get(address);
      if (addressCache === undefined) {
        addressCache = new Map();
        cache.set(address, addressCache);
      }

      const cacheKey = JSON.stringify([key.turn ?? null, key.state ?? null]);
      const cached = addressCache.get(cacheKey);
      if (cached !== undefined) return cached;

      const request = manager
        .call("terminal.read", { terminal: address })
        .then((result: ReadResult) => result.text.split(/\r?\n/))
        .catch((error: unknown) => {
          if (addressCache?.get(cacheKey) === request) addressCache.delete(cacheKey);
          throw error;
        });
      addressCache.set(cacheKey, request);
      return request;
    },
    invalidate(address) {
      cache.delete(address);
    },
  };
}
