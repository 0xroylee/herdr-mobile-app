import type { ProgramAdapter } from "../prompt.ts";

export const claudeAdapter: ProgramAdapter = {
  name: "Claude Code",
  matches: (app) => /claude/i.test(app),
  isApproval: (text) =>
    /\b(?:want|allow|approve|permission|edit|change|read|write|run|continue)\b/i.test(text),
  acceptsStatement: false,
  detail: extractFileDetail,
};

function extractFileDetail(context: readonly string[]): string | undefined {
  const headerIndex = findLastIndex(context, (line) =>
    /^(?:read|edit|write)\s+\S/i.test(line.trim()),
  );
  if (headerIndex < 0) return undefined;

  const header = context[headerIndex]?.trim() ?? "";
  const path = header.match(/^(?:read|edit|write)\s+(.+?)\s*$/i)?.[1]?.trim();
  if (path === undefined || path.length === 0) return undefined;

  const diffRows = context
    .slice(headerIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (diffRows.some((line) => !/^\+(?!\+)|^-(?!-)/.test(line))) return undefined;
  if (diffRows.length === 0) return path;

  const additions = diffRows.filter((line) => /^\+(?!\+)/.test(line)).length;
  const removals = diffRows.filter((line) => /^-(?!-)/.test(line)).length;
  return `${path} · +${additions} −${removals}`;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}
