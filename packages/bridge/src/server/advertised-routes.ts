import type { BridgeRoutes } from "@herdr-mobile/protocol";
import { normalizeOrigin } from "@herdr-mobile/protocol";

export interface AdvertisedRoutes {
  snapshot(): BridgeRoutes;
  setSecure(url: string | undefined): void;
}

/** Keeps the bridge's advertised origins in one mutable, validated snapshot. */
export function createAdvertisedRoutes(input: {
  direct: string;
  secure?: string;
}): AdvertisedRoutes {
  const direct = normalizeOrigin(input.direct, { allowPlainHttp: "loopback-only" });
  let secure =
    input.secure === undefined
      ? undefined
      : normalizeOrigin(input.secure, { allowPlainHttp: "loopback-and-private" });

  return {
    snapshot() {
      return { direct, ...(secure === undefined ? {} : { secure }) };
    },
    setSecure(url) {
      secure =
        url === undefined
          ? undefined
          : normalizeOrigin(url, { allowPlainHttp: "loopback-and-private" });
    },
  };
}
