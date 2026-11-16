import { HcRpcError } from "@herdr-mobile/hc-client";
import type {
  DeviceRecordView,
  StartAgentPlacement,
  StartAgentRun,
  TaskOutcome,
  TaskRecord,
  TasksDocument,
} from "@herdr-mobile/protocol";
import {
  parseTasksDoc,
  TASK_ID_PATTERN,
  TASKS_DOC_NAME,
  TASKS_MAX_AGE_MS,
  TASKS_MAX_RECORDS,
  TASKS_TARGET_BYTES,
} from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";
import type { CoreMethod } from "../server/core-call.ts";

export type TaskCoreCaller = (method: CoreMethod, params: unknown) => Promise<unknown>;

export interface TaskStoreOptions {
  /** Replaces terminal.list for pruning while the caller can provide a current terminal table. */
  liveTerminals?: () => ReadonlySet<string> | undefined;
}

export type TaskStoreErrorCode =
  | "core_unavailable"
  | "conflict"
  | "tasks_full"
  | "task_not_found"
  | "task_linked";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode) {
    super(code);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export interface CreateTaskFields {
  terminal?: string;
  text: string;
  run: StartAgentRun;
  folder: string;
  space?: { id: string };
  tab?: { id: string };
  placement?: StartAgentPlacement;
  createdBy?: Pick<DeviceRecordView, "id" | "name">;
}

interface ReadDocument {
  document: TasksDocument;
  version: number;
}

interface DocRecord {
  [key: string]: unknown;
}

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const utf8 = new TextEncoder();
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is DocRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is import("@herdr-mobile/protocol").JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function emptyDocument(): TasksDocument {
  return { v: 1, tasks: {} };
}

function cloneDocument(document: TasksDocument): TasksDocument {
  return {
    v: 1,
    tasks: Object.fromEntries(
      Object.entries(document.tasks).map(([id, record]) => [id, structuredClone(record)]),
    ),
  };
}

function makeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `tk${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isConflict(error: unknown): boolean {
  return error instanceof HcRpcError && error.kind === "conflict";
}

function normalizeCoreError(error: unknown): TaskStoreError {
  return error instanceof TaskStoreError ? error : new TaskStoreError("core_unavailable");
}

function serialize(document: TasksDocument): string {
  return JSON.stringify(document);
}

function documentBytes(document: TasksDocument): number {
  return utf8.encode(serialize(document)).byteLength;
}

function checked(record: TaskRecord): boolean {
  return record.checkedTurn !== undefined;
}

function ownTask(tasks: Record<string, TaskRecord>, id: string): TaskRecord | undefined {
  return Object.hasOwn(tasks, id) ? tasks[id] : undefined;
}

function validTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

function validTerminalAddress(address: string): boolean {
  return address.length > 0 && !PROTOTYPE_KEYS.has(address);
}

function taskRecord(input: unknown): TaskRecord | undefined {
  if (!isRecord(input) || !isJsonValue(input) || typeof input.id !== "string") return undefined;
  const parsed = parseTasksDoc({ v: 1, tasks: { [input.id]: input } });
  return parsed?.tasks[input.id];
}

function assertUniqueTerminal(document: TasksDocument): void {
  const addresses = new Set<string>();
  for (const record of Object.values(document.tasks)) {
    if (record.terminal === undefined) continue;
    if (addresses.has(record.terminal)) throw new TaskStoreError("task_linked");
    addresses.add(record.terminal);
  }
}

function liveTerminalSet(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.terminals)) {
    throw new TaskStoreError("core_unavailable");
  }
  const addresses = new Set<string>();
  for (const terminal of value.terminals) {
    if (
      isRecord(terminal) &&
      terminal.state === "live" &&
      terminal.reason == null &&
      typeof terminal.address === "string"
    ) {
      addresses.add(terminal.address);
    }
  }
  return addresses;
}

/** Stores task records in the core document and serializes versioned writes. */
export class TaskStore {
  private readonly caller: TaskCoreCaller;
  private readonly clock: Clock;
  private readonly options: TaskStoreOptions;
  private document: TasksDocument | undefined;
  private version: number | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private constructor(
    caller: TaskCoreCaller,
    clock: Clock,
    document: TasksDocument | undefined,
    version: number | undefined,
    options: TaskStoreOptions,
  ) {
    this.caller = caller;
    this.clock = clock;
    this.document = document;
    this.version = version;
    this.options = options;
  }

  static async open(
    caller: TaskCoreCaller,
    clock: Clock = systemClock,
    options: TaskStoreOptions = {},
  ): Promise<TaskStore> {
    try {
      const current = await TaskStore.read(caller);
      return new TaskStore(caller, clock, current.document, current.version, options);
    } catch {
      throw new TaskStoreError("core_unavailable");
    }
  }

  /** Creates a store without contacting the core; its first write loads the current document. */
  static create(
    caller: TaskCoreCaller,
    clock: Clock = systemClock,
    options: TaskStoreOptions = {},
  ): TaskStore {
    return new TaskStore(caller, clock, undefined, undefined, options);
  }

  snapshot(): TasksDocument {
    return cloneDocument(this.document ?? emptyDocument());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordOutcomes(changes: Readonly<Record<string, TaskOutcome | undefined>>): Promise<void> {
    return this.enqueue(async () => {
      await this.write((document) => {
        for (const [id, outcome] of Object.entries(changes)) {
          const record = ownTask(document.tasks, id);
          if (!record) continue;
          if (outcome === undefined) delete record.outcome;
          else record.outcome = structuredClone(outcome);
        }
      });
    });
  }

  create(fields: CreateTaskFields): Promise<TaskRecord> {
    const id = makeId();
    return this.enqueue(async () => {
      const candidate = await this.write((document) => {
        if (ownTask(document.tasks, id)) throw new TaskStoreError("task_linked");
        if (fields.terminal !== undefined && !validTerminalAddress(fields.terminal)) {
          throw new TaskStoreError("task_not_found");
        }
        if (
          fields.terminal !== undefined &&
          Object.values(document.tasks).some((record) => record.terminal === fields.terminal)
        ) {
          throw new TaskStoreError("task_linked");
        }
        const record: TaskRecord = {
          id,
          origin: "phone",
          text: fields.text,
          run: structuredClone(fields.run),
          folder: fields.folder,
          createdAt: this.clock.now(),
          ...(fields.terminal === undefined ? {} : { terminal: fields.terminal }),
          ...(fields.space === undefined ? {} : { space: structuredClone(fields.space) }),
          ...(fields.tab === undefined ? {} : { tab: structuredClone(fields.tab) }),
          ...(fields.placement === undefined ? {} : { placement: fields.placement }),
          ...(fields.createdBy === undefined
            ? {}
            : { createdBy: { deviceId: fields.createdBy.id, deviceName: fields.createdBy.name } }),
        };
        document.tasks[id] = record;
        return record;
      });
      const record = taskRecord(ownTask(candidate.tasks, id));
      if (!record) throw new TaskStoreError("core_unavailable");
      return record;
    });
  }

  link(id: string, address: string): Promise<TaskRecord> {
    return this.enqueue(async () => {
      const candidate = await this.write((document) => {
        if (!validTaskId(id) || !validTerminalAddress(address)) {
          throw new TaskStoreError("task_not_found");
        }
        const record = ownTask(document.tasks, id);
        if (!record) throw new TaskStoreError("task_not_found");
        if (record.terminal !== undefined) throw new TaskStoreError("task_linked");
        if (Object.values(document.tasks).some((other) => other.terminal === address)) {
          throw new TaskStoreError("task_linked");
        }
        record.terminal = address;
        return record;
      });
      const record = taskRecord(ownTask(candidate.tasks, id));
      if (!record) throw new TaskStoreError("task_not_found");
      return record;
    });
  }

  check(
    target: string | { terminal: string },
    turn: number,
    by: DeviceRecordView,
  ): Promise<TaskRecord> {
    const newId = makeId();
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(turn) || turn < 0) throw new TaskStoreError("task_not_found");
      if (
        (typeof target === "string" && !validTaskId(target)) ||
        (typeof target !== "string" && !validTerminalAddress(target.terminal))
      ) {
        throw new TaskStoreError("task_not_found");
      }
      const candidate = await this.write((document) => {
        const byTerminal = new Map<string, TaskRecord>();
        for (const [id, item] of Object.entries(document.tasks)) {
          if (Object.hasOwn(document.tasks, id) && item.terminal !== undefined) {
            byTerminal.set(item.terminal, item);
          }
        }
        let record =
          typeof target === "string"
            ? ownTask(document.tasks, target)
            : byTerminal.get(target.terminal);
        if (typeof target === "string" && !record) throw new TaskStoreError("task_not_found");
        if (!record && typeof target !== "string") {
          record = {
            id: newId,
            origin: "herdr",
            terminal: target.terminal,
            createdAt: this.clock.now(),
          };
          document.tasks[newId] = record;
        }
        if (!record) throw new TaskStoreError("task_not_found");
        record.checkedTurn = turn;
        record.checkedAt = this.clock.now();
        record.checkedBy = { deviceId: by.id, deviceName: by.name };
        return record;
      });
      const id = typeof target === "string" ? target : ownTask(candidate.tasks, newId)?.id;
      const record = id === undefined ? undefined : taskRecord(ownTask(candidate.tasks, id));
      if (!record && typeof target === "object") {
        const matched = Object.values(candidate.tasks).find(
          (item) => item.terminal === target.terminal,
        );
        if (matched) return structuredClone(matched);
      }
      if (!record) throw new TaskStoreError("task_not_found");
      return record;
    });
  }

  uncheck(id: string): Promise<TaskRecord> {
    return this.enqueue(async () => {
      const candidate = await this.write((document) => {
        if (!validTaskId(id)) throw new TaskStoreError("task_not_found");
        const record = ownTask(document.tasks, id);
        if (!record) throw new TaskStoreError("task_not_found");
        delete record.checkedTurn;
        delete record.checkedAt;
        delete record.checkedBy;
        return record;
      });
      const record = taskRecord(ownTask(candidate.tasks, id));
      if (!record) throw new TaskStoreError("task_not_found");
      return record;
    });
  }

  clear(spaceId: string | undefined, liveTerminals: ReadonlySet<string>): Promise<string[]> {
    return this.enqueue(async () => {
      const candidate = await this.write((document) => {
        const removed: string[] = [];
        for (const [id, record] of Object.entries(document.tasks)) {
          if (!Object.hasOwn(document.tasks, id)) continue;
          if (
            checked(record) &&
            (spaceId === undefined || record.space?.id === spaceId) &&
            (record.terminal === undefined || !liveTerminals.has(record.terminal))
          ) {
            delete document.tasks[id];
            removed.push(id);
          }
        }
        return removed;
      }, liveTerminals);
      return candidate.result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const write = this.writeTail.catch(() => {}).then(operation);
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async write<T>(
    mutate: (document: TasksDocument) => T,
    knownLiveTerminals?: ReadonlySet<string>,
  ): Promise<{ tasks: Record<string, TaskRecord>; result: T }> {
    await this.ensureLoaded();
    const providedLiveTerminals =
      knownLiveTerminals === undefined ? this.options.liveTerminals?.() : undefined;
    const live = knownLiveTerminals ?? providedLiveTerminals ?? (await this.readLiveTerminals());
    let base: ReadDocument = {
      document: this.document ?? emptyDocument(),
      version: this.version ?? 0,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = cloneDocument(base.document);
      const result = mutate(candidate);
      this.prune(candidate, live);
      assertUniqueTerminal(candidate);
      if (documentBytes(candidate) > MAX_DOCUMENT_BYTES) throw new TaskStoreError("tasks_full");

      try {
        const response = await this.caller("doc.set", {
          name: TASKS_DOC_NAME,
          version: base.version,
          value: candidate,
        });
        if (
          !isRecord(response) ||
          !Number.isSafeInteger(response.version) ||
          (response.version as number) < 0
        ) {
          throw new TaskStoreError("core_unavailable");
        }
        const nextVersion = response.version as number;
        this.document = candidate;
        this.version = nextVersion;
        this.notifyChange();
        return { tasks: candidate.tasks, result };
      } catch (error) {
        if (error instanceof TaskStoreError) throw error;
        if (!isConflict(error)) throw normalizeCoreError(error);
        if (attempt === 1) throw new TaskStoreError("conflict");
        try {
          base = await TaskStore.read(this.caller);
          this.document = base.document;
          this.version = base.version;
          this.notifyChange();
        } catch (readError) {
          throw normalizeCoreError(readError);
        }
      }
    }
    throw new TaskStoreError("conflict");
  }

  private prune(document: TasksDocument, liveTerminals: ReadonlySet<string>): void {
    const now = this.clock.now();
    const checkedRecords = Object.values(document.tasks).filter(checked);
    for (const record of checkedRecords) {
      if (record.checkedAt !== undefined && now - record.checkedAt > TASKS_MAX_AGE_MS) {
        if (Object.hasOwn(document.tasks, record.id)) delete document.tasks[record.id];
      }
    }

    const ended = Object.values(document.tasks)
      .filter(
        (record) =>
          checked(record) && (record.terminal === undefined || !liveTerminals.has(record.terminal)),
      )
      .sort(
        (left, right) =>
          (right.checkedAt ?? right.createdAt) - (left.checkedAt ?? left.createdAt) ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id),
      );
    const keep = new Set(ended.slice(0, TASKS_MAX_RECORDS).map((record) => record.id));
    for (const record of ended) {
      if (!keep.has(record.id) && Object.hasOwn(document.tasks, record.id)) {
        delete document.tasks[record.id];
      }
    }

    if (documentBytes(document) <= TASKS_TARGET_BYTES) return;
    for (const record of [...ended].reverse()) {
      if (documentBytes(document) <= TASKS_TARGET_BYTES) break;
      if (Object.hasOwn(document.tasks, record.id)) delete document.tasks[record.id];
    }
  }

  private async readLiveTerminals(): Promise<ReadonlySet<string>> {
    try {
      return liveTerminalSet(await this.caller("terminal.list", {}));
    } catch (error) {
      throw normalizeCoreError(error);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document !== undefined && this.version !== undefined) return;
    try {
      const current = await TaskStore.read(this.caller);
      this.document = current.document;
      this.version = current.version;
    } catch (error) {
      throw normalizeCoreError(error);
    }
  }

  private notifyChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A subscriber cannot roll back a confirmed document write.
      }
    }
  }

  private static async read(caller: TaskCoreCaller): Promise<ReadDocument> {
    const value = await caller("doc.get", { name: TASKS_DOC_NAME });
    if (
      !isRecord(value) ||
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      !isJsonValue(value.value)
    ) {
      throw new TaskStoreError("core_unavailable");
    }
    return {
      document: parseTasksDoc(value.value) ?? emptyDocument(),
      version: value.version,
    };
  }
}
