import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Keeps feature-map.md in step with the code. See its "Keeping it current" section.

const root = join(import.meta.dir, "..");
const map = readFileSync(join(import.meta.dir, "feature-map.md"), "utf8");

/** The map writes code paths from one of these folders. */
const bases = ["", "packages/app/src", "packages/bridge/src"];

const segment = String.raw`[\w.()[\]-]+`;
const folderPath = new RegExp(`^${segment}/(${segment}/)*(${segment}\\.(ts|tsx|md|json|css))?$`);
const bareFile = new RegExp(`^${segment}\\.(ts|tsx)$`);

/** Code spans that name a file or folder, such as `screens/agent/actions.ts` or `boot.tsx`. */
const codePaths = [...map.matchAll(/`([^`\s]+)`/g)]
  .map((match) => match[1] ?? "")
  .filter((text) => folderPath.test(text) || bareFile.test(text));

function resolveCodePath(path: string): string | undefined {
  const base = bases.find((folder) => existsSync(join(root, folder, path)));
  return base === undefined ? undefined : join(base, path).replace(/\/$/, "");
}

const resolvedPaths = codePaths.flatMap((path) => resolveCodePath(path) ?? []);

/** A file is covered when the map names it, a folder when the map names it or a file inside it. */
function isCovered(path: string): boolean {
  return resolvedPaths.some((entry) => entry === path || entry.startsWith(`${path}/`));
}

const featureIds = [...map.matchAll(/^\| ([A-Z]+-\d+) +\|/gm)].map((match) => match[1] ?? "");

describe("feature map", () => {
  test("every code path exists", () => {
    expect(codePaths.filter((path) => resolveCodePath(path) === undefined)).toEqual([]);
  });

  test("every relative link resolves", () => {
    const targets = [...map.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => (match[1] ?? "").split("#")[0] ?? "")
      .filter((target) => target.length > 0 && !/^[a-z]+:/.test(target));
    expect(targets.filter((target) => !existsSync(join(import.meta.dir, target)))).toEqual([]);
  });

  test("every app route has a row", () => {
    const routes = readdirSync(join(root, "packages/app/src/app"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => join("packages/app/src/app", file));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((route) => !isCovered(route))).toEqual([]);
  });

  test("every screen folder has a row", () => {
    const folders = readdirSync(join(root, "packages/app/src/screens"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("packages/app/src/screens", entry.name));
    expect(folders.length).toBeGreaterThan(0);
    expect(folders.filter((folder) => !isCovered(folder))).toEqual([]);
  });

  test("every bridge command has a row", () => {
    const cli = readFileSync(join(root, "packages/bridge/src/server/cli.ts"), "utf8");
    const commands = new Set([...cli.matchAll(/herdr-bridge ([a-z]+)/g)].map((match) => match[1]));
    expect(commands.size).toBeGreaterThan(0);
    expect([...commands].filter((command) => !map.includes(`herdr-bridge ${command}`))).toEqual([]);
  });

  test("feature IDs are unique", () => {
    expect(featureIds.length).toBeGreaterThan(0);
    expect(featureIds.filter((id, index) => featureIds.indexOf(id) !== index)).toEqual([]);
  });

  test("every cited feature ID has a row", () => {
    const areas = [...new Set(featureIds.map((id) => id.split("-")[0]))];
    const cited = map.match(new RegExp(String.raw`\b(${areas.join("|")})-\d+\b`, "g")) ?? [];
    expect([...new Set(cited)].filter((id) => !featureIds.includes(id))).toEqual([]);
  });
});
