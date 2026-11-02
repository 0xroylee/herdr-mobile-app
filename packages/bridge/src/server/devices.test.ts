import { describe, expect, test } from "bun:test";
import type { Clock } from "../prototype/deadline.ts";
import type { StoreFs } from "./devices.ts";
import { DeviceFileError, DeviceStore } from "./devices.ts";
import { hashToken } from "./tokens.ts";

const DEVICE_FILE = "/state/devices.json";

type FsOperation = "readFile" | "mkdir" | "writeFile" | "rename" | "unlink";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FileEntry {
  contents: string;
  mode: number;
}

class MapFs implements StoreFs {
  readonly files = new Map<string, FileEntry>();
  readonly calls: FsOperation[] = [];
  readonly directories: string[] = [];
  readonly writes: { path: string; contents: string; mode: number; flag: "wx" }[] = [];
  readonly renames: [string, string][] = [];
  readonly unlinks: string[] = [];

  protected async beforeOperation(_operation: FsOperation): Promise<void> {}

  private async enter(operation: FsOperation): Promise<void> {
    this.calls.push(operation);
    await this.beforeOperation(operation);
  }

  async readFile(path: string): Promise<string | undefined> {
    await this.enter("readFile");
    return this.files.get(path)?.contents;
  }

  async mkdir(path: string): Promise<void> {
    await this.enter("mkdir");
    this.directories.push(path);
  }

  async writeFile(
    path: string,
    contents: string,
    options: { mode: number; flag: "wx" },
  ): Promise<void> {
    await this.enter("writeFile");
    if (this.files.has(path)) throw new Error("temporary file already exists");
    this.files.set(path, { contents, mode: options.mode });
    this.writes.push({ path, contents, mode: options.mode, flag: options.flag });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.enter("rename");
    const entry = this.files.get(from);
    if (!entry) throw new Error("missing temporary file");
    this.files.set(to, entry);
    this.files.delete(from);
    this.renames.push([from, to]);
  }

  async unlink(path: string): Promise<void> {
    await this.enter("unlink");
    this.files.delete(path);
    this.unlinks.push(path);
  }
}

class DeferredMapFs extends MapFs {
  readonly gates: Partial<Record<FsOperation, Deferred>> = {};
  readonly failNext: Partial<Record<FsOperation, Error>> = {};
  private readonly waiters = new Map<FsOperation, { count: number; signal: Deferred }[]>();
  private readonly gatesByCall = new Map<FsOperation, Map<number, Deferred>>();
  private readonly failuresByCall = new Map<FsOperation, Map<number, Error>>();

  gateOnCall(operation: FsOperation, occurrence: number, gate: Deferred): void {
    const gates = this.gatesByCall.get(operation) ?? new Map<number, Deferred>();
    gates.set(occurrence, gate);
    this.gatesByCall.set(operation, gates);
  }

  failOnCall(operation: FsOperation, occurrence: number, failure: Error): void {
    const failures = this.failuresByCall.get(operation) ?? new Map<number, Error>();
    failures.set(occurrence, failure);
    this.failuresByCall.set(operation, failures);
  }

  waitForCall(operation: FsOperation, occurrence = 1): Promise<void> {
    const count = this.calls.filter((call) => call === operation).length;
    if (count >= occurrence) return Promise.resolve();
    const signal = deferred();
    const operationWaiters = this.waiters.get(operation) ?? [];
    operationWaiters.push({ count: occurrence, signal });
    this.waiters.set(operation, operationWaiters);
    return signal.promise;
  }

  protected override async beforeOperation(operation: FsOperation): Promise<void> {
    const occurrence = this.calls.filter((call) => call === operation).length;
    const gate = this.gates[operation];
    if (gate) {
      delete this.gates[operation];
      await gate.promise;
    }
    const callGate = this.gatesByCall.get(operation)?.get(occurrence);
    if (callGate) {
      this.gatesByCall.get(operation)?.delete(occurrence);
      await callGate.promise;
    }
    const callFailure = this.failuresByCall.get(operation)?.get(occurrence);
    if (callFailure) {
      this.failuresByCall.get(operation)?.delete(occurrence);
      throw callFailure;
    }
    const failure = this.failNext[operation];
    if (failure) {
      delete this.failNext[operation];
      throw failure;
    }
  }

  override async readFile(path: string): Promise<string | undefined> {
    const pending = super.readFile(path);
    this.signalWaiters("readFile");
    return pending;
  }

  override async mkdir(path: string): Promise<void> {
    const pending = super.mkdir(path);
    this.signalWaiters("mkdir");
    return pending;
  }

  override async writeFile(
    path: string,
    contents: string,
    options: { mode: number; flag: "wx" },
  ): Promise<void> {
    const pending = super.writeFile(path, contents, options);
    this.signalWaiters("writeFile");
    return pending;
  }

  override async rename(from: string, to: string): Promise<void> {
    const pending = super.rename(from, to);
    this.signalWaiters("rename");
    return pending;
  }

  override async unlink(path: string): Promise<void> {
    const pending = super.unlink(path);
    this.signalWaiters("unlink");
    return pending;
  }

  private signalWaiters(operation: FsOperation): void {
    const count = this.calls.filter((call) => call === operation).length;
    const operationWaiters = this.waiters.get(operation);
    if (!operationWaiters) return;
    const remaining = operationWaiters.filter((waiter) => {
      if (count >= waiter.count) {
        waiter.signal.resolve();
        return false;
      }
      return true;
    });
    if (remaining.length === 0) this.waiters.delete(operation);
    else this.waiters.set(operation, remaining);
  }
}

class FakeClock implements Clock {
  time = 1_000_000;
  onNow?: () => void;

  now(): number {
    this.onNow?.();
    return this.time;
  }

  setTimeout(): unknown {
    throw new Error("device store does not schedule timers");
  }

  clearTimeout(): void {}
}

async function storedDevice(id: string, token: string, lastSeenAt: number | null = null) {
  return {
    id,
    name: "Phone",
    role: "watch" as const,
    createdAt: 1_000,
    lastSeenAt,
    tokenHash: await hashToken(token),
  };
}

function setStoreFile(fs: MapFs, contents: string, path = DEVICE_FILE): void {
  fs.files.set(path, { contents, mode: 0o600 });
}

async function expectRejectedOpen(
  fs: MapFs,
  path = DEVICE_FILE,
  messageIncludes?: string,
): Promise<void> {
  const original = fs.files.get(path)?.contents;
  const error = await DeviceStore.open(fs, path, new FakeClock()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeviceFileError);
  if (!(error instanceof DeviceFileError))
    throw new Error("open did not reject with DeviceFileError");
  expect(error.path).toBe(path);
  expect(error.message).toContain(path);
  if (messageIncludes) expect(error.message).toContain(messageIncludes);
  expect(fs.calls).toEqual(["readFile"]);
  expect(fs.directories).toHaveLength(0);
  expect(fs.writes).toHaveLength(0);
  expect(fs.renames).toHaveLength(0);
  expect(fs.unlinks).toHaveLength(0);
  expect(fs.files.get(path)?.contents).toBe(original);
}

describe("DeviceStore", () => {
  test("opens a missing file as empty and then persists a paired device", async () => {
    const fs = new MapFs();
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());

    expect(store.list()).toEqual([]);
    expect(fs.calls).toEqual(["readFile"]);
    const device = await store.add({
      token: "plain-token-for-phone",
      role: "control",
      name: "Phone",
    });

    expect(store.list()).toEqual([device]);
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")).toHaveLength(1);
  });

  test("stores only a token hash and atomically renames a mode-0600 temp file", async () => {
    const fs = new MapFs();
    const store = await DeviceStore.open(fs, "/state/herdr-bridge/devices.json", new FakeClock());
    const device = await store.add({
      token: "plain-token-for-phone",
      role: "control",
      name: "Phone",
    });

    const persisted = fs.files.get("/state/herdr-bridge/devices.json");
    expect(persisted).toBeDefined();
    expect(persisted?.mode).toBe(0o600);
    expect(persisted?.contents).not.toContain("plain-token-for-phone");
    expect(persisted?.contents).toContain("tokenHash");
    expect(fs.writes).toEqual([expect.objectContaining({ mode: 0o600, flag: "wx" })]);
    const temporaryPath = fs.writes[0]?.path;
    expect(temporaryPath).toBeDefined();
    if (!temporaryPath) throw new Error("atomic save did not write a temporary file");
    expect(temporaryPath.startsWith("/state/herdr-bridge/devices.json.tmp-")).toBe(true);
    expect(fs.renames[0]).toEqual([temporaryPath, "/state/herdr-bridge/devices.json"]);
    expect([...fs.files.keys()]).toEqual(["/state/herdr-bridge/devices.json"]);
    expect(store.list()).toEqual([device]);
    expect(Object.hasOwn(store.list()[0] ?? {}, "tokenHash")).toBe(false);
  });

  test("tracks last-seen in memory and saves no more than once a minute", async () => {
    const fs = new MapFs();
    const clock = new FakeClock();
    const store = await DeviceStore.open(fs, DEVICE_FILE, clock);
    const device = await store.add({ token: "phone-token", role: "watch" });
    const writesAfterAdd = fs.writes.length;

    const firstSeen = await store.findByToken("phone-token");
    expect(firstSeen?.lastSeenAt).toBe(clock.time);
    expect(fs.writes).toHaveLength(writesAfterAdd + 1);

    clock.time += 30_000;
    const secondSeen = await store.findByToken("phone-token");
    expect(secondSeen?.lastSeenAt).toBe(clock.time);
    expect(store.list()[0]?.lastSeenAt).toBe(clock.time);
    expect(fs.writes).toHaveLength(writesAfterAdd + 1);

    clock.time += 30_000;
    await store.findByToken("phone-token");
    expect(fs.writes).toHaveLength(writesAfterAdd + 2);

    const reloaded = await DeviceStore.open(fs, DEVICE_FILE, clock);
    expect(reloaded.list()).toEqual([{ ...device, lastSeenAt: clock.time }]);
  });

  test("a revoked token no longer authenticates and a second revoke is false", async () => {
    const fs = new MapFs();
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    const device = await store.add({ token: "revoke-me", role: "watch" });

    expect(await store.revoke(device.id)).toBe(true);
    expect(await store.findByToken("revoke-me")).toBeUndefined();
    expect(await store.revoke(device.id)).toBe(false);
  });

  test("rejects malformed JSON without touching the file", async () => {
    const fs = new MapFs();
    setStoreFile(fs, "{");
    await expectRejectedOpen(fs);
  });

  test("rejects a primitive record without touching the file", async () => {
    const fs = new MapFs();
    setStoreFile(fs, "[1]");

    await expectRejectedOpen(fs, DEVICE_FILE, "invalid device record");
  });

  test("rejects a non-array top level without touching the file", async () => {
    const fs = new MapFs();
    setStoreFile(fs, JSON.stringify({ devices: [] }));
    await expectRejectedOpen(fs);
  });

  test("rejects a valid record followed by an invalid record without touching the file", async () => {
    const fs = new MapFs();
    const record = await storedDevice("device-one", "valid-prefix-token");
    setStoreFile(fs, JSON.stringify([record, {}]));
    await expectRejectedOpen(fs);
  });

  test("rejects records with an invalid role without touching the file", async () => {
    const fs = new MapFs();
    setStoreFile(
      fs,
      JSON.stringify([{ ...(await storedDevice("device-one", "bad-role-token")), role: "admin" }]),
    );
    await expectRejectedOpen(fs);
  });

  test("rejects duplicate device ids without authenticating a partial file", async () => {
    const fs = new MapFs();
    const first = await storedDevice("duplicate-id", "first-token");
    const second = await storedDevice("duplicate-id", "second-token");
    setStoreFile(fs, JSON.stringify([first, second]));
    await expectRejectedOpen(fs);
  });

  test("wraps a read failure and leaves the existing bytes untouched", async () => {
    const fs = new DeferredMapFs();
    const original = JSON.stringify([{ invalid: "device" }]);
    setStoreFile(fs, original);
    fs.failNext.readFile = new Error("read denied");

    await expectRejectedOpen(fs, DEVICE_FILE, "read denied");
  });

  test("opens a corrected file after a failed open and authenticates its device", async () => {
    const fs = new MapFs();
    const record = await storedDevice("device-one", "valid-prefix-token");
    setStoreFile(fs, JSON.stringify([record, {}]));
    await expect(DeviceStore.open(fs, DEVICE_FILE, new FakeClock())).rejects.toBeInstanceOf(
      DeviceFileError,
    );

    setStoreFile(fs, JSON.stringify([record]));
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    expect(await store.findByToken("valid-prefix-token")).toMatchObject({
      id: "device-one",
      role: "watch",
    });
  });

  test("an invalid concurrent open never writes beside a live store's in-flight write", async () => {
    const fs = new DeferredMapFs();
    setStoreFile(fs, "[]");
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    const mkdirGate = deferred();
    fs.gates.mkdir = mkdirGate;

    const add = store.add({ token: "live-store-token", role: "watch" });
    await fs.waitForCall("mkdir");
    const writesBeforeOpen = fs.writes.length;
    const renamesBeforeOpen = fs.renames.length;
    const unlinksBeforeOpen = fs.unlinks.length;
    setStoreFile(fs, "[{}]");

    const callsBeforeOpen = fs.calls.length;
    await expect(DeviceStore.open(fs, DEVICE_FILE, new FakeClock())).rejects.toBeInstanceOf(
      DeviceFileError,
    );
    expect(fs.calls.slice(callsBeforeOpen)).toEqual(["readFile"]);
    expect(fs.writes).toHaveLength(writesBeforeOpen);
    expect(fs.renames).toHaveLength(renamesBeforeOpen);
    expect(fs.unlinks).toHaveLength(unlinksBeforeOpen);

    mkdirGate.resolve();
    await add;
    const committedSnapshot = JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null") as {
      tokenHash: string;
    }[];
    expect(committedSnapshot).toHaveLength(1);
    expect(committedSnapshot[0]?.tokenHash).toBe(await hashToken("live-store-token"));
    expect(await store.findByToken("live-store-token")).toMatchObject({ role: "watch" });
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")).toHaveLength(1);
  });

  test("overlapping opens can finish out of order without sharing state", async () => {
    const fs = new DeferredMapFs();
    const malformedPath = "/state/malformed-devices.json";
    const workingPath = "/state/working-devices.json";
    setStoreFile(fs, "[{}]", malformedPath);
    setStoreFile(fs, "[]", workingPath);
    const readGate = deferred();
    fs.gates.readFile = readGate;

    const failingOpen = DeviceStore.open(fs, malformedPath, new FakeClock());
    await fs.waitForCall("readFile");
    const workingStore = await DeviceStore.open(fs, workingPath, new FakeClock());
    const device = await workingStore.add({ token: "working-open-token", role: "control" });
    const workingBytes = fs.files.get(workingPath)?.contents;

    readGate.resolve();
    await expect(failingOpen).rejects.toBeInstanceOf(DeviceFileError);
    expect(fs.files.get(malformedPath)?.contents).toBe("[{}]");
    expect(fs.files.get(workingPath)?.contents).toBe(workingBytes);
    expect(workingStore.list()).toEqual([device]);
    expect(await workingStore.findByToken("working-open-token")).toMatchObject({
      id: device.id,
    });
  });

  test("a last-seen save returns undefined when the device is revoked while it is in flight", async () => {
    const fs = new DeferredMapFs();
    const record = await storedDevice("device-one", "racing-token");
    setStoreFile(fs, JSON.stringify([record]));
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    const writeGate = deferred();
    fs.gates.writeFile = writeGate;

    const finding = store.findByToken("racing-token");
    await fs.waitForCall("writeFile");
    const revoking = store.revoke("device-one");
    expect(store.list()).toEqual([]);

    writeGate.resolve();
    await expect(finding).resolves.toBeUndefined();
    await expect(revoking).resolves.toBe(true);
    expect(fs.renames).toHaveLength(2);
    expect(fs.renames[0]?.[0]).not.toBe(fs.renames[1]?.[0]);
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")).toEqual([]);
  });

  test("serializes writes in request order and persists the latest memory snapshot", async () => {
    const fs = new DeferredMapFs();
    const clock = new FakeClock();
    setStoreFile(fs, "[]");
    const store = await DeviceStore.open(fs, DEVICE_FILE, clock);
    const firstWriteGate = deferred();
    fs.gates.writeFile = firstWriteGate;

    const firstAdd = store.add({ token: "first-write-token", role: "watch" });
    await fs.waitForCall("writeFile");
    const secondClockCall = deferred();
    clock.onNow = secondClockCall.resolve;
    const secondAdd = store.add({ token: "second-write-token", role: "control" });
    await secondClockCall.promise;
    clock.onNow = undefined;

    expect(store.list()).toHaveLength(2);
    expect(fs.calls.filter((call) => call === "writeFile")).toHaveLength(1);

    const secondWriteGate = deferred();
    fs.gates.writeFile = secondWriteGate;
    firstWriteGate.resolve();
    await fs.waitForCall("writeFile", 2);
    const thirdClockCall = deferred();
    clock.onNow = thirdClockCall.resolve;
    const thirdAdd = store.add({ token: "third-write-token", role: "watch" });
    await thirdClockCall.promise;
    clock.onNow = undefined;

    expect(store.list()).toHaveLength(3);
    expect(fs.calls.filter((call) => call === "writeFile")).toHaveLength(2);

    secondWriteGate.resolve();
    const [firstDevice, secondDevice, thirdDevice] = await Promise.all([
      firstAdd,
      secondAdd,
      thirdAdd,
    ]);
    expect(fs.writes).toHaveLength(3);
    expect(new Set(fs.writes.map((write) => write.path)).size).toBe(3);
    expect(fs.writes.every((write) => write.mode === 0o600 && write.flag === "wx")).toBe(true);
    expect(fs.renames).toEqual([
      [fs.writes[0]?.path ?? "", DEVICE_FILE],
      [fs.writes[1]?.path ?? "", DEVICE_FILE],
      [fs.writes[2]?.path ?? "", DEVICE_FILE],
    ]);
    const finalSnapshot = JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null");
    expect(finalSnapshot).toHaveLength(3);
    expect(finalSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstDevice.id }),
        expect.objectContaining({ id: secondDevice.id }),
        expect.objectContaining({ id: thirdDevice.id }),
      ]),
    );
    expect(JSON.parse(fs.writes[0]?.contents ?? "null")).toEqual([
      expect.objectContaining({ id: firstDevice.id }),
    ]);
    const secondSnapshot = JSON.parse(fs.writes[1]?.contents ?? "null");
    expect(secondSnapshot).toHaveLength(2);
    expect(secondSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstDevice.id }),
        expect.objectContaining({ id: secondDevice.id }),
      ]),
    );
    const thirdSnapshot = JSON.parse(fs.writes[2]?.contents ?? "null");
    expect(thirdSnapshot).toHaveLength(3);
    expect(thirdSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstDevice.id }),
        expect.objectContaining({ id: secondDevice.id }),
        expect.objectContaining({ id: thirdDevice.id }),
      ]),
    );
    expect([...fs.files.keys()]).toEqual([DEVICE_FILE]);
  });

  for (const failureOperation of ["mkdir", "writeFile", "rename"] as const) {
    test(`keeps a rejected concurrent add out of snapshots when ${failureOperation} fails`, async () => {
      const fs = new DeferredMapFs();
      const clock = new FakeClock();
      setStoreFile(fs, "[]");
      const store = await DeviceStore.open(fs, DEVICE_FILE, clock);
      const firstWriteGate = deferred();
      fs.gates.writeFile = firstWriteGate;

      const firstAdd = store.add({ token: "first-device-token", role: "watch" });
      await fs.waitForCall("writeFile");

      const additionsReady = deferred();
      let readyCount = 0;
      clock.onNow = () => {
        readyCount += 1;
        if (readyCount === 2) additionsReady.resolve();
      };
      const secondAdd = store.add({ token: "second-device-token", role: "control" });
      const thirdAdd = store.add({ token: "rejected-device-token", role: "watch" });
      await additionsReady.promise;
      clock.onNow = undefined;
      expect(store.list()).toHaveLength(3);

      const operationCalls = fs.calls.filter((call) => call === failureOperation).length;
      const failedCall = operationCalls + (failureOperation === "rename" ? 3 : 2);
      const failure = new Error(`${failureOperation} failed`);
      fs.failOnCall(failureOperation, failedCall, failure);
      firstWriteGate.resolve();

      const outcomes = await Promise.allSettled([firstAdd, secondAdd, thirdAdd]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "rejected",
      ]);
      expect(outcomes[2]).toMatchObject({ status: "rejected", reason: failure });

      const firstDevice = await firstAdd;
      const secondDevice = await secondAdd;
      const secondSnapshot = JSON.parse(fs.writes[1]?.contents ?? "null") as { id: string }[];
      expect(secondSnapshot.map((record) => record.id)).toEqual([firstDevice.id, secondDevice.id]);
      const memoryIds = store.list().map((device) => device.id);
      expect(memoryIds).toEqual([firstDevice.id, secondDevice.id]);

      const fileRecords = JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null") as {
        id: string;
      }[];
      expect(fileRecords.map((record) => record.id)).toEqual([firstDevice.id, secondDevice.id]);

      const reopened = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
      expect(reopened.list().map((device) => device.id)).toEqual([firstDevice.id, secondDevice.id]);
      expect(await reopened.findByToken("rejected-device-token")).toBeUndefined();
    });
  }

  test("rolls back an add when its temporary write fails", async () => {
    const fs = new DeferredMapFs();
    const original = "[]";
    setStoreFile(fs, original);
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    const failure = new Error("write failed");
    fs.failNext.writeFile = failure;

    await expect(store.add({ token: "failed-add-token", role: "control" })).rejects.toBe(failure);

    expect(store.list()).toEqual([]);
    expect(fs.files.get(DEVICE_FILE)?.contents).toBe(original);
    expect(fs.unlinks).toHaveLength(1);
    expect([...fs.files.keys()]).toEqual([DEVICE_FILE]);
  });

  test("a failed add followed by a successful add persists only the successful device", async () => {
    const fs = new DeferredMapFs();
    setStoreFile(fs, "[]");
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    fs.failNext.writeFile = new Error("first add failed");

    await expect(store.add({ token: "failed-add-token", role: "watch" })).rejects.toThrow(
      "first add failed",
    );
    const successfulDevice = await store.add({ token: "successful-add-token", role: "control" });

    const fileRecords = JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null") as {
      id: string;
      tokenHash: string;
    }[];
    expect(fileRecords).toEqual([
      expect.objectContaining({
        id: successfulDevice.id,
        tokenHash: await hashToken("successful-add-token"),
      }),
    ]);
    expect(store.list()).toEqual([successfulDevice]);
  });

  test("keeps a revoked device deleted after a failed rename and heals on the next write", async () => {
    const fs = new DeferredMapFs();
    const record = await storedDevice("device-one", "rename-failure-token", 1_000_000);
    setStoreFile(fs, JSON.stringify([record]));
    const store = await DeviceStore.open(fs, DEVICE_FILE, new FakeClock());
    const failure = new Error("rename failed");
    fs.failNext.rename = failure;

    await expect(store.revoke("device-one")).rejects.toBe(failure);
    expect(store.list()).toEqual([]);
    expect(await store.findByToken("rename-failure-token")).toBeUndefined();
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")).toHaveLength(1);

    await store.add({ token: "after-revoke-token", role: "watch" });
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")).toEqual([
      expect.objectContaining({ tokenHash: await hashToken("after-revoke-token") }),
    ]);
  });

  test("retries a failed throttled last-seen save at the same clock time", async () => {
    const fs = new DeferredMapFs();
    const clock = new FakeClock();
    const store = await DeviceStore.open(fs, DEVICE_FILE, clock);
    await store.add({ token: "retry-last-seen-token", role: "watch" });
    const failure = new Error("last-seen write failed");
    fs.failNext.writeFile = failure;

    await expect(store.findByToken("retry-last-seen-token")).rejects.toBe(failure);
    const retried = await store.findByToken("retry-last-seen-token");

    expect(retried?.lastSeenAt).toBe(clock.time);
    expect(fs.calls.filter((call) => call === "writeFile")).toHaveLength(3);
    expect(JSON.parse(fs.files.get(DEVICE_FILE)?.contents ?? "null")[0]?.lastSeenAt).toBe(
      clock.time,
    );
  });
});
