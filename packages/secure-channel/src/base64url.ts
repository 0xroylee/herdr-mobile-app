const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) {
  VALUES[ALPHABET.charCodeAt(i)] = i;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset] as number;
    const hasSecond = offset + 1 < bytes.byteLength;
    const hasThird = offset + 2 < bytes.byteLength;
    const second = hasSecond ? (bytes[offset + 1] as number) : 0;
    const third = hasThird ? (bytes[offset + 2] as number) : 0;

    output += ALPHABET[first >>> 2];
    output += ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    if (hasSecond) output += ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    if (hasThird) output += ALPHABET[third & 0x3f];
  }
  return output;
}

export function decodeBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new TypeError("invalid base64url value");
  }

  const output = new Uint8Array(Math.floor((text.length * 6) / 8));
  let outputOffset = 0;
  let accumulator = 0;
  let availableBits = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < VALUES.length ? (VALUES[code] as number) : -1;
    if (value < 0) throw new TypeError("invalid base64url value");
    accumulator = (accumulator << 6) | value;
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      output[outputOffset++] = (accumulator >>> availableBits) & 0xff;
      accumulator &= (1 << availableBits) - 1;
    }
  }

  if (accumulator !== 0 || outputOffset !== output.byteLength) {
    throw new TypeError("non-canonical base64url value");
  }
  return output;
}
