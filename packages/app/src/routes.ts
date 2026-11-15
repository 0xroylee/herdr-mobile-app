export type SmartListKind = "needs-you" | "running" | "done";

export const routes = {
  home: "/",
  // Kept as aliases while the existing pairing and Start flows transition in later units.
  agents: "/",
  spaces: "/",
  settings: "/settings",
  pair: "/pair",
  start: "/start",
  project: (id: string) => ({ pathname: "/project/[id]", params: { id } }) as const,
  projectTerminals: (id: string) =>
    ({ pathname: "/project/[id]/terminals", params: { id } }) as const,
  list: (kind: SmartListKind) => ({ pathname: "/list/[kind]", params: { kind } }) as const,
  task: (id: string) => ({ pathname: "/task/[id]", params: { id } }) as const,
  agent: (address: string) => ({ pathname: "/agent/[address]", params: { address } }) as const,
} as const;
