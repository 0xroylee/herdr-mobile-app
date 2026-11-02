export interface PairInput {
  url: string;
  code: string;
}

/** Parse a full URL or fragment containing the bridge's base64url `#pair=` payload. */
export function parsePairFragment(input: string): PairInput | undefined {
  const fragment = getFragment(input);
  if (!fragment.startsWith("#pair=")) return undefined;
  const encoded = fragment.slice("#pair=".length);
  if (encoded.length === 0 || encoded.includes("&")) return undefined;

  const decoded = decodeBase64Url(encoded);
  if (decoded === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(decoded);
    if (!isRecord(payload) || typeof payload.u !== "string" || typeof payload.c !== "string") {
      return undefined;
    }
    return parseTypedPairInput(payload.u, payload.c);
  } catch {
    return undefined;
  }
}

/** Validate a bridge URL and the 8-character code entered by the user. */
export function parseTypedPairInput(urlInput: string, codeInput: string): PairInput | undefined {
  const code = codeInput.trim();
  if (!/^[a-zA-Z0-9]{8}$/.test(code)) return undefined;

  let url: URL;
  try {
    url = new URL(urlInput.trim());
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }

  return { url: url.origin, code };
}

function getFragment(input: string): string {
  if (input.startsWith("#")) return input;
  try {
    return new URL(input).hash;
  } catch {
    return "";
  }
}

function decodeBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;

  for (const character of encoded) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = (accumulator << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
    }
  }

  try {
    return decodeURIComponent(
      bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
    );
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
