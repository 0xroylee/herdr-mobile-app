import * as SecureStore from "expo-secure-store";
import type { Secrets } from "./secrets.ts";

const secrets: Secrets = {
  get: (key) => SecureStore.getItemAsync(secretKey(key)),
  set: async (key, value) => {
    await SecureStore.setItemAsync(secretKey(key), value);
  },
  remove: async (key) => {
    await SecureStore.deleteItemAsync(secretKey(key));
  },
};

function secretKey(key: string): string {
  return `herdr.${key}`;
}

export default secrets;
