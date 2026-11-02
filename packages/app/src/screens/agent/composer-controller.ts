import { useCallback, useState, useSyncExternalStore } from "react";

export interface ComposerSnapshot {
  value: string;
  pending: boolean;
}

/** Owns composer input and its synchronous, duplicate-safe submission transition. */
export class ComposerController {
  private snapshot: ComposerSnapshot = { value: "", pending: false };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): ComposerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setValue(value: string): void {
    if (this.snapshot.pending || this.snapshot.value === value) return;
    this.update({ ...this.snapshot, value });
  }

  submit(disabled: boolean, onSend: (text: string) => Promise<boolean>): Promise<boolean> {
    const value = this.snapshot.value;
    if (disabled || this.snapshot.pending || value.trim().length === 0) {
      return Promise.resolve(false);
    }

    this.update({ ...this.snapshot, pending: true });
    return (async () => {
      try {
        const sent = await onSend(value);
        if (sent) this.update({ ...this.snapshot, value: "" });
        return sent;
      } finally {
        this.update({ ...this.snapshot, pending: false });
      }
    })();
  }

  private update(snapshot: ComposerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useComposerController() {
  const [controller] = useState(() => new ComposerController());
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const setValue = useCallback((value: string) => controller.setValue(value), [controller]);
  const submit = useCallback(
    (disabled: boolean, onSend: (text: string) => Promise<boolean>) =>
      controller.submit(disabled, onSend),
    [controller],
  );
  return { ...snapshot, setValue, submit };
}
