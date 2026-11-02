import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceRecordView, Role } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";
import { hashToken } from "./tokens.ts";

const LAST_SEEN_SAVE_INTERVAL_MS = 60_000;
const DEVICE_FILE_MODE = 0o600;

interface StoredDevice extends DeviceRecordView {
  tokenHash: string;
}

export interface StoreFs {
  readFile(path: string): Promise<string | undefined>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string, options: { mode: number; flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The real filesystem adapter used by the bridge process. */
export const nodeStoreFs: StoreFs = {
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeFile(path, contents, options) {
    await writeFile(path, contents, options);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async unlink(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  },
};

function isRole(value: unknown): value is Role {
  return value === "watch" || value === "control";
}

function parseStoredDevice(value: unknown): StoredDevice {
  if (typeof value !== "object" || value === null) throw new Error("invalid device record");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    !isRole(record.role) ||
    typeof record.createdAt !== "number" ||
    !(record.lastSeenAt === null || typeof record.lastSeenAt === "number") ||
    typeof record.tokenHash !== "string"
  ) {
    throw new Error("invalid device record");
  }
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    tokenHash: record.tokenHash,
  };
}

function viewOf(device: StoredDevice): DeviceRecordView {
  return {
    id: device.id,
    name: device.name,
    role: device.role,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 160) || "unknown error";
}

/** A device file could not be read or validated when opening the store. */
export class DeviceFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "DeviceFileError";
    this.path = path;
  }
}

/** Stores device credentials by digest and writes snapshots using same-directory atomic rename. */
export class DeviceStore {
  private readonly records: Map<string, StoredDevice>;
  private readonly committedIds: Set<string>;
  private readonly lastSeenSavedAt: Map<string, number>;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly fs: StoreFs;
  readonly path: string;
  private readonly clock: Clock;

  private constructor(
    fs: StoreFs,
    path: string,
    clock: Clock,
    records: Map<string, StoredDevice>,
    lastSeenSavedAt: Map<string, number>,
  ) {
    this.fs = fs;
    this.path = path;
    this.clock = clock;
    this.records = records;
    this.committedIds = new Set(records.keys());
    this.lastSeenSavedAt = lastSeenSavedAt;
  }

  static async open(fs: StoreFs, path: string, clock: Clock = systemClock): Promise<DeviceStore> {
    const records = new Map<string, StoredDevice>();
    const lastSeenSavedAt = new Map<string, number>();
    try {
      const contents = await fs.readFile(path);
      if (contents !== undefined) {
        const parsed: unknown = JSON.parse(contents);
        if (!Array.isArray(parsed)) throw new Error("invalid device store");
        for (const item of parsed) {
          const device = parseStoredDevice(item);
          if (records.has(device.id)) throw new Error("duplicate device id");
          records.set(device.id, device);
          if (device.lastSeenAt !== null) {
            lastSeenSavedAt.set(device.id, device.lastSeenAt);
          }
        }
      }
    } catch (error) {
      throw new DeviceFileError(path, errorReason(error));
    }

    return new DeviceStore(fs, path, clock, records, lastSeenSavedAt);
  }

  async add(input: { token: string; role: Role; name?: string }): Promise<DeviceRecordView> {
    const tokenHash = await hashToken(input.token);
    const device: StoredDevice = {
      id: crypto.randomUUID(),
      name: input.name?.trim() || "Device",
      role: input.role,
      createdAt: this.clock.now(),
      lastSeenAt: null,
      tokenHash,
    };
    this.records.set(device.id, device);
    try {
      await this.persist(device.id);
    } catch (error) {
      this.records.delete(device.id);
      this.committedIds.delete(device.id);
      this.lastSeenSavedAt.delete(device.id);
      throw error;
    }
    return viewOf(device);
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.records.delete(id)) return false;
    this.lastSeenSavedAt.delete(id);
    await this.persist();
    return true;
  }

  list(): DeviceRecordView[] {
    return [...this.records.values()].map(viewOf);
  }

  async findByToken(token: string): Promise<DeviceRecordView | undefined> {
    const tokenHash = await hashToken(token);
    const device = [...this.records.values()].find((record) => record.tokenHash === tokenHash);
    if (!device) return undefined;

    const now = this.clock.now();
    device.lastSeenAt = now;
    const savedAt = this.lastSeenSavedAt.get(device.id);
    if (savedAt === undefined || now - savedAt >= LAST_SEEN_SAVE_INTERVAL_MS) {
      this.lastSeenSavedAt.set(device.id, now);
      try {
        await this.persist();
      } catch (error) {
        if (this.lastSeenSavedAt.get(device.id) === now) {
          if (savedAt === undefined) this.lastSeenSavedAt.delete(device.id);
          else this.lastSeenSavedAt.set(device.id, savedAt);
        }
        throw error;
      }
      if (!this.records.has(device.id)) return undefined;
    }
    return viewOf(device);
  }

  private persist(additionId?: string): Promise<void> {
    const write = this.writeTail
      .catch(() => {})
      .then(async () => {
        const includesAddition = additionId !== undefined && this.records.has(additionId);
        const contents = JSON.stringify(
          [...this.records.values()].filter(
            (record) =>
              this.committedIds.has(record.id) || (includesAddition && record.id === additionId),
          ),
        );
        await this.writeAtomic(contents);
        if (includesAddition && additionId !== undefined) this.committedIds.add(additionId);
      });
    this.writeTail = write;
    return write;
  }

  private async writeAtomic(contents: string): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await this.fs.mkdir(directory);
      await this.fs.writeFile(temporaryPath, contents, {
        mode: DEVICE_FILE_MODE,
        flag: "wx",
      });
      await this.fs.rename(temporaryPath, this.path);
    } catch (error) {
      await this.fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}
