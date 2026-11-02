const TOKEN_BYTES = 32;

/** Encodes bytes as unpadded base64url. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Creates a 256-bit bearer token using the Web Crypto random source. */
export function createToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** Returns a base64url SHA-256 digest suitable for storing instead of a bearer token. */
export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}
