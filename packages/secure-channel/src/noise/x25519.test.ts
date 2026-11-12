import { describe, expect, test } from "bun:test";
import { x25519 as nobleX25519 } from "@noble/curves/ed25519.js";
import { x25519 } from "./x25519.ts";

function fromHex(hexText: string): Uint8Array {
  const bytes = new Uint8Array(hexText.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexText.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("package X25519", () => {
  test("matches RFC 7748 section 5.2 vectors", () => {
    const expectedOutput = "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552";
    const vectors = [
      {
        scalar: "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
        u: "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
        output: expectedOutput,
      },
    ];

    for (const vector of vectors) {
      expect(hex(x25519.getSharedSecret(fromHex(vector.scalar), fromHex(vector.u)))).toBe(
        vector.output,
      );
    }

    const clampedScalarVariants = fromHex(
      "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
    );
    clampedScalarVariants[0] = (clampedScalarVariants[0] as number) | 7;
    clampedScalarVariants[31] = (clampedScalarVariants[31] as number) | 128;
    expect(
      hex(
        x25519.getSharedSecret(
          clampedScalarVariants,
          fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
        ),
      ),
    ).toBe(expectedOutput);
  });

  test("matches the RFC 7748 section 6.1 Alice and Bob vector", () => {
    const aliceSecret = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const alicePublic = fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    const bobSecret = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    const bobPublic = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    const sharedSecret = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

    expect(hex(x25519.getPublicKey(aliceSecret))).toBe(hex(alicePublic));
    expect(hex(x25519.getPublicKey(bobSecret))).toBe(hex(bobPublic));
    expect(hex(x25519.getSharedSecret(aliceSecret, bobPublic))).toBe(sharedSecret);
    expect(hex(x25519.getSharedSecret(bobSecret, alicePublic))).toBe(sharedSecret);
  });

  test("matches the RFC 7748 section 6.1 1,000-iteration vector", () => {
    let scalar = new Uint8Array(32);
    scalar[0] = 9;
    let u = scalar.slice();

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const next = x25519.getSharedSecret(scalar, u);
      u = scalar;
      scalar = next;
    }

    expect(hex(scalar)).toBe("684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51");
  });

  test("matches Noble Ed25519 X25519 for random key pairs", () => {
    for (let index = 0; index < 8; index += 1) {
      const localSecret = x25519.utils.randomSecretKey();
      const remoteSecret = x25519.utils.randomSecretKey();
      const localPublic = x25519.getPublicKey(localSecret);
      const remotePublic = x25519.getPublicKey(remoteSecret);

      expect(localPublic).toEqual(nobleX25519.getPublicKey(localSecret));
      expect(remotePublic).toEqual(nobleX25519.getPublicKey(remoteSecret));
      expect(x25519.getSharedSecret(localSecret, remotePublic)).toEqual(
        nobleX25519.getSharedSecret(localSecret, remotePublic),
      );
      expect(x25519.getSharedSecret(remoteSecret, localPublic)).toEqual(
        nobleX25519.getSharedSecret(remoteSecret, localPublic),
      );
    }
  });
});
