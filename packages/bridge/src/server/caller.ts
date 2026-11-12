import type { DeviceRecordView } from "@herdr-mobile/protocol";
import type { DeviceStore } from "./devices.ts";
import type { IdentityConfig, WhoisLookup } from "./identity.ts";
import { checkIdentity } from "./identity.ts";

export interface Caller {
  device: DeviceRecordView;
}

export type ResolveCaller = (request: Request) => Promise<Caller | undefined>;

export class CallerIdentityDeniedError extends Error {
  constructor() {
    super("caller identity denied");
    this.name = "CallerIdentityDeniedError";
  }
}

export type CallerResolution = { ok: true; caller: Caller } | { ok: false; status: 401 | 403 };

/** Resolves the direct-route identity header and bearer token as one caller. */
export function headerCaller(
  identity: IdentityConfig,
  whois: WhoisLookup | undefined,
  devices: DeviceStore,
): ResolveCaller {
  return async (request) => {
    if (!(await checkIdentity(request.headers, identity, whois))) {
      throw new CallerIdentityDeniedError();
    }
    const authorization = request.headers.get("Authorization");
    const token = authorization ? /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization)?.[1] : undefined;
    if (!token) return undefined;
    const device = await devices.findByToken(token);
    return device ? { device } : undefined;
  };
}

/** Identity-only authorization for the direct pairing endpoint. */
export function headerPairingAuthorization(
  identity: IdentityConfig,
  whois: WhoisLookup | undefined,
): (request: Request) => Promise<boolean> {
  return (request) => checkIdentity(request.headers, identity, whois);
}

/** Binds every request in an authenticated channel to its paired device. */
export function boundCaller(device: DeviceRecordView): ResolveCaller {
  return async () => ({ device });
}

export async function resolveCallerResult(
  request: Request,
  resolveCaller: ResolveCaller,
): Promise<CallerResolution> {
  try {
    const caller = await resolveCaller(request);
    return caller ? { ok: true, caller } : { ok: false, status: 401 };
  } catch (error) {
    if (error instanceof CallerIdentityDeniedError) return { ok: false, status: 403 };
    throw error;
  }
}
