export interface PairOffer {
  direct?: string;
  secure?: string;
  bridgeKey?: string;
  code: string;
  name?: string;
}

export type PlainHttpRule = "loopback-only" | "loopback-and-private" | "any";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PAIR_CODE = /^[A-Za-z0-9]{8}$/u;

interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  pathname: string;
  search: string;
  hash: string;
  hostname: string;
  origin: string;
}

type RuntimeUrl = new (value: string) => ParsedUrl;

/** Normalize a bridge route to an HTTP(S) origin under the named plain-HTTP policy. */
export function normalizeOrigin(value: string, options: { allowPlainHttp: PlainHttpRule }): string {
  let url: ParsedUrl;
  try {
    url = parseUrl(value.trim());
  } catch {
    throw new Error("route URL must be a valid HTTP or HTTPS origin");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "route URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment",
    );
  }

  if (url.protocol === "http:") {
    const host = url.hostname;
    const allowed =
      options.allowPlainHttp === "any" ||
      (options.allowPlainHttp === "loopback-only" && isLoopbackHost(host)) ||
      (options.allowPlainHttp === "loopback-and-private" && isPrivateOrLoopbackHost(host));
    if (!allowed) {
      const scope =
        options.allowPlainHttp === "loopback-only" ? "loopback" : "loopback or private-network";
      throw new Error(`plain HTTP route must use a ${scope} host`);
    }
  }

  return url.origin;
}

/** True for IPv4/IPv6 loopback, private, and link-local addresses, plus localhost. */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "localhost" || isLoopbackHost(normalized)) return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const ipv6 = parseIpv6(normalized);
  if (!ipv6) return false;
  if (isIpv6Loopback(ipv6)) return true;
  if (ipv6[0] !== undefined && (ipv6[0] & 0xfe00) === 0xfc00) return true;
  if (ipv6[0] !== undefined && (ipv6[0] & 0xffc0) === 0xfe80) return true;

  const mapped = mappedIpv4Address(ipv6);
  return mapped !== undefined && isPrivateOrLoopbackHost(mapped);
}

/** Encode a v2 pair offer into the link whose origin matches its preferred route. */
export function encodePairOffer(offer: PairOffer): string {
  const direct =
    offer.direct === undefined
      ? undefined
      : normalizeOrigin(offer.direct, { allowPlainHttp: "any" });
  const secure =
    offer.secure === undefined
      ? undefined
      : normalizeOrigin(offer.secure, { allowPlainHttp: "any" });
  if (!direct && !secure) throw new Error("pair offer requires a direct or secure route");
  if (!PAIR_CODE.test(offer.code))
    throw new Error("pair offer code must contain 8 letters or digits");
  if (offer.bridgeKey !== undefined && decodeBase64Url(offer.bridgeKey)?.length !== 32) {
    throw new Error("pair offer bridge key must be 32 bytes in base64url");
  }

  const payload = {
    v: 2,
    ...(direct === undefined ? {} : { u: direct }),
    ...(secure === undefined ? {} : { s: secure }),
    ...(offer.bridgeKey === undefined ? {} : { k: offer.bridgeKey }),
    c: offer.code,
    ...(offer.name === undefined ? {} : { n: offer.name }),
  };
  const base = secure ?? direct;
  if (base === undefined) throw new Error("pair offer requires a route");
  return `${base}/#pair=${encodeBase64Url(JSON.stringify(payload))}`;
}

/** Parse a v1 or v2 pairing fragment. Invalid values always return undefined. */
export function parsePairOffer(fragmentOrUrl: string): PairOffer | undefined {
  const fragment = pairFragment(fragmentOrUrl);
  if (!fragment.startsWith("#pair=")) return undefined;
  const encoded = fragment.slice("#pair=".length);
  if (encoded.length === 0 || encoded.includes("&")) return undefined;
  const decodedBytes = decodeBase64Url(encoded);
  if (decodedBytes === undefined) return undefined;
  const decoded = decodeUtf8(decodedBytes);
  if (decoded === undefined) return undefined;

  try {
    const payload: unknown = JSON.parse(decoded);
    if (!isRecord(payload) || typeof payload.c !== "string" || !PAIR_CODE.test(payload.c)) {
      return undefined;
    }
    if (payload.v === undefined) {
      if (typeof payload.u !== "string") return undefined;
      const direct = normalizeOrigin(payload.u, { allowPlainHttp: "any" });
      return { direct, code: payload.c };
    }
    if (payload.v !== 2) return undefined;

    const direct = payload.u === undefined ? undefined : route(payload.u);
    const secure = payload.s === undefined ? undefined : route(payload.s);
    if (payload.u !== undefined && direct === undefined) return undefined;
    if (payload.s !== undefined && secure === undefined) return undefined;
    if (direct === undefined && secure === undefined) return undefined;
    if (
      payload.k !== undefined &&
      (typeof payload.k !== "string" || decodeBase64Url(payload.k)?.length !== 32)
    ) {
      return undefined;
    }
    if (payload.n !== undefined && typeof payload.n !== "string") return undefined;

    return {
      ...(direct === undefined ? {} : { direct }),
      ...(secure === undefined ? {} : { secure }),
      ...(typeof payload.k === "string" ? { bridgeKey: payload.k } : {}),
      code: payload.c,
      ...(typeof payload.n === "string" ? { name: payload.n } : {}),
    };
  } catch {
    return undefined;
  }
}

function route(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeOrigin(value, { allowPlainHttp: "any" });
}

function pairFragment(input: string): string {
  if (input.startsWith("#")) return input;
  try {
    return parseUrl(input).hash;
  } catch {
    return "";
  }
}

function parseUrl(value: string): ParsedUrl {
  const UrlConstructor = (globalThis as unknown as { URL: RuntimeUrl }).URL;
  return new UrlConstructor(value);
}

function normalizeHost(host: string): string {
  let normalized = host.toLowerCase().replace(/\.$/u, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "localhost") return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return ipv4[0] === 127;
  const ipv6 = parseIpv6(normalized);
  if (!ipv6) return false;
  if (isIpv6Loopback(ipv6)) return true;
  const mapped = mappedIpv4Address(ipv6);
  return mapped !== undefined && isLoopbackHost(mapped);
}

function isIpv6Loopback(words: readonly number[]): boolean {
  return words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
}

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : -1));
  return octets.every((part) => part >= 0 && part <= 255) ? octets : undefined;
}

function parseIpv6(host: string): number[] | undefined {
  if (!host.includes(":")) return undefined;
  let value = host;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = parseIpv4(value.slice(separator + 1));
    if (separator < 0 || !ipv4) return undefined;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    value = `${value.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (half: string): number[] | undefined => {
    if (half === "") return [];
    const groups = half.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseGroups(halves[0] ?? "");
  const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!left || !right) return undefined;
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || (halves.length === 2 && zeros < 1)) {
    return undefined;
  }
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

function mappedIpv4Address(words: readonly number[]): string | undefined {
  if (
    words[0] !== 0 ||
    words[1] !== 0 ||
    words[2] !== 0 ||
    words[3] !== 0 ||
    words[4] !== 0 ||
    words[5] !== 0xffff
  ) {
    return undefined;
  }
  const highWord = words[6];
  const lowWord = words[7];
  if (highWord === undefined || lowWord === undefined) return undefined;
  return [highWord >> 8, highWord & 0xff, lowWord >> 8, lowWord & 0xff].join(".");
}

function encodeBase64Url(value: string): string {
  const escaped = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] === "%") {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(escaped.charCodeAt(index));
    }
  }
  let output = "";
  let accumulator = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 6) {
      bitCount -= 6;
      output += BASE64URL[(accumulator >> bitCount) & 0x3f];
    }
  }
  if (bitCount > 0) output += BASE64URL[(accumulator << (6 - bitCount)) & 0x3f];
  return output;
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = (accumulator << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
    }
  }
  if (bitCount > 0 && (accumulator & ((1 << bitCount) - 1)) !== 0) return undefined;
  return new Uint8Array(bytes);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const escaped = Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(escaped);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
