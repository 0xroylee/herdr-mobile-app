import KeyValueStore from "expo-sqlite/kv-store";
import type { Storage } from "./storage.ts";

const storage: Storage = {
  getItem: (key) => KeyValueStore.getItem(key),
  setItem: (key, value) => KeyValueStore.setItem(key, value),
  removeItem: (key) => KeyValueStore.removeItem(key),
};

export default storage;
