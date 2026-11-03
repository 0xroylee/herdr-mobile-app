import type { ProgramAdapter } from "../prompt.ts";

export const codexAdapter: ProgramAdapter = {
  name: "Codex",
  matches: (app) => /codex/i.test(app),
  isApproval: (text) => /\b(?:command|run|execute|approval|permission|allow|network)\b/i.test(text),
  acceptsStatement: true,
};
