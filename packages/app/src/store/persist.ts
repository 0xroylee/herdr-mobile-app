import { createJSONStorage, type PersistStorage } from "zustand/middleware";
import type { Storage } from "./storage.ts";

/** Add JSON serialization to a storage adapter for zustand's persist middleware. */
export function createPersistStorage<State>(storage: Storage): PersistStorage<State> {
  const jsonStorage = createJSONStorage<State>(() => storage);
  if (!jsonStorage) throw new Error("Could not create JSON storage");
  return jsonStorage;
}
