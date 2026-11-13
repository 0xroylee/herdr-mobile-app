import * as ExpoCrypto from "expo-crypto";
import { Platform } from "react-native";

if (Platform.OS !== "web") {
  const cryptoObject = globalThis.crypto ?? ({} as Crypto);
  if (typeof cryptoObject.getRandomValues !== "function") {
    Object.defineProperty(cryptoObject, "getRandomValues", {
      configurable: true,
      value: ExpoCrypto.getRandomValues,
    });
    if (globalThis.crypto === undefined) {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoObject });
    }
  }
}
