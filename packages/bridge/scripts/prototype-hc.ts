// bun run prototype:hc: one checked run of the bridge prototype against a scratch herdr-core.
// It never reaches the person's own core; see src/prototype/scratch.ts for how.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { systemClock } from "../src/prototype/deadline.ts";
import { bunRunner } from "../src/prototype/process.ts";
import { headlessRenderer } from "../src/prototype/renderer.ts";
import { runPrototype } from "../src/prototype/workflow.ts";

const SCRATCH_PREFIX = "/tmp/hmp-";

const result = await runPrototype({
  runner: bunRunner,
  fs: {
    makeTempDir: (prefix) => mkdtempSync(prefix),
    makeDir: (path) => mkdirSync(path, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text),
    remove: (path) => {
      if (!path.startsWith(SCRATCH_PREFIX)) throw new Error(`refusing to remove ${path}`);
      rmSync(path, { recursive: true, force: true });
    },
  },
  clock: systemClock,
  renderer: headlessRenderer,
  print: (line) => console.log(line),
  env: process.env,
  random: () => crypto.randomUUID().slice(0, 8),
  onInterrupt: (listener) => {
    process.on("SIGINT", () => listener("SIGINT"));
    process.on("SIGTERM", () => listener("SIGTERM"));
  },
});
process.exit(result.ok ? 0 : 1);
