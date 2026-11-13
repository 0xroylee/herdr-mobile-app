import { normalizeOrigin, type PairOffer, parsePairOffer } from "@herdr-mobile/protocol";

export type PairInput = PairOffer;

/** Parse a full URL or fragment containing the bridge's base64url `#pair=` payload. */
export function parsePairFragment(input: string): PairInput | undefined {
  return parsePairOffer(input);
}

/** Validate a bridge URL and the 8-character code entered by the user. */
export function parseTypedPairInput(urlInput: string, codeInput: string): PairInput | undefined {
  const code = codeInput.trim();
  if (!/^[a-zA-Z0-9]{8}$/.test(code)) return undefined;

  try {
    const direct = normalizeOrigin(urlInput, { allowPlainHttp: "any" });
    return { direct, code };
  } catch {
    return undefined;
  }
}
