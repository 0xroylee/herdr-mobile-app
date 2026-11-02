import type { Secrets } from "./secrets.ts";

const secrets: Secrets = {
  get: async (key) => globalThis.localStorage.getItem(secretKey(key)),
  set: async (key, value) => {
    globalThis.localStorage.setItem(secretKey(key), value);
  },
  remove: async (key) => {
    globalThis.localStorage.removeItem(secretKey(key));
  },
};

function secretKey(key: string): string {
  return `herdr.${key}`;
}

export default secrets;
