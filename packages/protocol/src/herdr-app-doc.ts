import type { JsonValue } from "./wire.ts";

export interface LayoutTab {
  id: string;
  name: string;
  terminalAddresses: string[];
}

export interface LayoutSpace {
  id: string;
  name: string;
  folder: string | null;
  tabs: LayoutTab[];
}

/** The app document fields the phone needs to display spaces and tabs. */
export interface Layout {
  spaces: LayoutSpace[];
}

/** Parse the known herdr-app layout shape without depending on other fields. */
export function parseHerdrAppDoc(value: JsonValue): Layout | undefined {
  if (!isJsonObject(value) || !Array.isArray(value.spaces)) return undefined;

  const spaces: LayoutSpace[] = [];
  for (const valueSpace of value.spaces) {
    const space = parseSpace(valueSpace);
    if (space !== undefined) spaces.push(space);
  }

  return { spaces };
}

function parseSpace(value: JsonValue): LayoutSpace | undefined {
  if (!isJsonObject(value)) return undefined;
  const { id, name, folder, tabs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !(typeof folder === "string" || folder === null) ||
    !Array.isArray(tabs)
  ) {
    return undefined;
  }

  const parsedTabs: LayoutTab[] = [];
  for (const valueTab of tabs) {
    const tab = parseTab(valueTab);
    if (tab !== undefined) parsedTabs.push(tab);
  }

  return { id, name, folder, tabs: parsedTabs };
}

function parseTab(value: JsonValue): LayoutTab | undefined {
  if (!isJsonObject(value)) return undefined;
  const { id, name, root } = value;
  if (typeof id !== "string" || typeof name !== "string" || !isJsonObject(root)) {
    return undefined;
  }

  return { id, name, terminalAddresses: readTerminalAddresses(root) };
}

function readTerminalAddresses(root: { [key: string]: JsonValue }): string[] {
  const terminalAddresses: string[] = [];
  const worklist: JsonValue[] = [root];

  while (worklist.length > 0) {
    const value = worklist.pop();
    if (!isJsonObject(value) || typeof value.type !== "string" || typeof value.id !== "string") {
      continue;
    }

    if (value.type === "block") {
      if (isJsonObject(value.content) && typeof value.content.terminal === "string") {
        terminalAddresses.push(value.content.terminal);
      }
      continue;
    }

    if (!Array.isArray(value.children)) continue;
    for (let index = value.children.length - 1; index >= 0; index -= 1) {
      const child = value.children[index];
      if (child !== undefined) worklist.push(child);
    }
  }

  return terminalAddresses;
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
