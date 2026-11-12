import { pow } from "@noble/curves/abstract/modular.js";
import { montgomery } from "@noble/curves/abstract/montgomery.js";

const P = 2n ** 255n - 19n;

export const x25519 = montgomery({
  P,
  type: "x25519",
  adjustScalarBytes(bytes: Uint8Array): Uint8Array {
    const scalar = new Uint8Array(bytes);
    scalar[0] = (scalar[0] as number) & 248;
    scalar[31] = ((scalar[31] as number) & 127) | 64;
    return scalar;
  },
  powPminus2: (x) => pow(x, P - 2n, P),
});
