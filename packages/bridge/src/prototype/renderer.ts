// A screen the prototype renders attach output into, so it can return credit only for bytes that
// are on it: the reference viewer in herdr-core's tests/common/framed.rs writes, then credits.

import { Terminal } from "@xterm/headless";

export interface Renderer {
  /** Puts bytes on the screen; `done` runs once they are there. */
  write(bytes: Uint8Array, done: () => void): void;
  /** The visible rows as text, trailing blanks trimmed. */
  lines(): string[];
  dispose(): void;
}

export function headlessRenderer(cols: number, rows: number): Renderer {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  return {
    write: (bytes, done) => terminal.write(bytes, done),
    lines: () => {
      const buffer = terminal.buffer.active;
      const out: string[] = [];
      for (let y = buffer.baseY; y < buffer.baseY + terminal.rows; y++) {
        out.push(buffer.getLine(y)?.translateToString(true) ?? "");
      }
      return out;
    },
    dispose: () => terminal.dispose(),
  };
}
