export const routes = {
  home: "/",
  // Kept as aliases for the screens still transitioning to task-first navigation.
  agents: "/",
  spaces: "/",
  settings: "/settings",
  pair: "/pair",
  project: (id: string, focus?: "composer") =>
    ({
      pathname: "/project/[id]",
      params: { id, ...(focus ? { focus } : {}) },
    }) as const,
  projectTerminals: (id: string) =>
    ({ pathname: "/project/[id]/terminals", params: { id } }) as const,
  task: (id: string) => ({ pathname: "/task/[id]", params: { id } }) as const,
  taskNew: (project: string, draft: string) =>
    ({ pathname: "/task/new", params: { project, draft } }) as const,
  agent: (address: string) => ({ pathname: "/agent/[address]", params: { address } }) as const,
} as const;
