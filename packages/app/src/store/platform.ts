import { createCoreStore } from "./core.ts";
import { createMachinesStore } from "./machines.ts";
// These extensionless imports are the platform split: Metro selects .native.ts or .web.ts.
import platformSecrets from "./platform-secrets";
import platformStorage from "./platform-storage";
import type { Secrets } from "./secrets.ts";
import { createSeenStore } from "./seen.ts";
import { createSettingsStore } from "./settings.ts";
import type { Storage } from "./storage.ts";

export const appStorage: Storage = platformStorage;
export const appSecrets: Secrets = platformSecrets;
export const settingsStore = createSettingsStore(appStorage);
export const machinesStore = createMachinesStore(appStorage, appSecrets);
export const seenStore = createSeenStore(appStorage);
export const coreStore = createCoreStore();
