export type ParentEnv = Record<string, string | undefined>;

export interface ConnectEnvConfig {
  /** A configured core session name. The parent's HC_SESSION is never inherited by accident. */
  session?: string;
}

const FORBIDDEN = [
  "HC_SOCKET",
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
  "HC_SCOPE",
  "HC_RUNTIME",
] as const;

/** Builds the complete, allow-listed environment for one `hc connect` child. */
export function connectEnv(
  parent: ParentEnv,
  config: ConnectEnvConfig = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LANGUAGE"] as const) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(parent)) {
    if (/^LC_[A-Z0-9_]+$/.test(key) && value !== undefined) env[key] = value;
  }
  if (config.session !== undefined) env.HC_SESSION = config.session;

  // Keep the deny-list explicit here: scratch.ts intentionally does not export it.
  for (const key of FORBIDDEN) delete env[key];
  return env;
}
