import type { Clock } from "../prototype/deadline.ts";
import { systemClock, within } from "../prototype/deadline.ts";
import type { ProcessRunner } from "../prototype/process.ts";

const WHOIS_TIMEOUT_MS = 5_000;

export interface IdentityConfig {
  ownerLogin: string;
}

export type WhoisLookup = (address: string) => Promise<string>;

export interface WhoisAdapterOptions {
  env: Record<string, string>;
  cwd: string;
  clock?: Clock;
  timeoutMs?: number;
}

/** Checks the Tailscale identity headers, optionally confirming the peer with `tailscale whois`. */
export async function checkIdentity(
  headers: Headers,
  config: IdentityConfig,
  whois?: WhoisLookup,
): Promise<boolean> {
  const login = headers.get("Tailscale-User-Login");
  if (!login || login !== config.ownerLogin) return false;
  if (!whois) return true;

  const address = headers.get("X-Forwarded-For")?.trim();
  if (!address || address.includes(",")) return false;
  try {
    return (await whois(address)) === config.ownerLogin;
  } catch {
    return false;
  }
}

/** Creates the header-plus-whois identity adapter using the bridge's ProcessRunner seam. */
export function createWhoisLookup(
  runner: ProcessRunner,
  options: WhoisAdapterOptions,
): WhoisLookup {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? WHOIS_TIMEOUT_MS;

  return async (address) => {
    const child = runner.spawn(["tailscale", "whois", "--json", address], {
      env: options.env,
      cwd: options.cwd,
    });
    try {
      const chunks: Uint8Array[] = [];
      let outputBytes = 0;
      let closeOutput: () => void = () => {};
      const outputClosed = new Promise<void>((resolve) => {
        closeOutput = resolve;
      });
      child.read((chunk) => {
        chunks.push(chunk.slice());
        outputBytes += chunk.byteLength;
      }, closeOutput);

      const work = Promise.all([outputClosed, child.exited]).then(([, exitCode]) => {
        if (exitCode !== 0) throw new Error("tailscale whois exited unsuccessfully");
        const output = new Uint8Array(outputBytes);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(output));
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("UserProfile" in parsed) ||
          typeof parsed.UserProfile !== "object" ||
          parsed.UserProfile === null ||
          !("LoginName" in parsed.UserProfile) ||
          typeof parsed.UserProfile.LoginName !== "string"
        ) {
          throw new Error("tailscale whois returned an invalid profile");
        }
        return parsed.UserProfile.LoginName;
      });

      return await within("tailscale whois", work, timeoutMs, clock, new AbortController().signal);
    } catch (error) {
      child.kill();
      throw error;
    }
  };
}
