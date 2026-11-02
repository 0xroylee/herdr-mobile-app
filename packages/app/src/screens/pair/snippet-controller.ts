import type * as ExpoClipboard from "expo-clipboard";

export const PAIR_COMMAND = "herdr-bridge pair";

export interface SnippetState {
  copied: boolean;
  failed: boolean;
}

export function createSnippetController(clipboard: Pick<typeof ExpoClipboard, "setStringAsync">) {
  let state: SnippetState = { copied: false, failed: false };
  const listeners = new Set<() => void>();

  const update = (next: SnippetState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async copy(): Promise<void> {
      try {
        const copied = await clipboard.setStringAsync(PAIR_COMMAND);
        update(copied ? { copied: true, failed: false } : { copied: false, failed: true });
      } catch {
        update({ copied: false, failed: true });
      }
    },
  };
}
