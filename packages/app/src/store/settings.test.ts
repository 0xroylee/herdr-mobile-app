/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createSettingsStore } from "./settings.ts";
import type { Storage } from "./storage.ts";

describe("settings last run", () => {
  test("persists the last agent per Mac", async () => {
    const storage = new MemoryStorage();
    const settings = createSettingsStore(storage);
    settings.getState().setLastRun("machine-1", { kind: "template", name: "review" });
    await flushPersistence();

    const restored = createSettingsStore(storage);
    await restored.persist.rehydrate();

    expect(restored.getState().lastRun).toEqual({
      "machine-1": { kind: "template", name: "review" },
    });
  });

  test("does not persist a run without a machine id", async () => {
    const storage = new MemoryStorage();
    const settings = createSettingsStore(storage);
    settings.getState().setLastRun(" ", { kind: "program", id: "codex" });

    expect(settings.getState().lastRun).toEqual({});
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  getItem(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeItem(name: string): void {
    this.values.delete(name);
  }
}

async function flushPersistence(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
