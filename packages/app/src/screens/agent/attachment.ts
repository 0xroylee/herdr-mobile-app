import type { AttachHandle, StreamEnd } from "@herdr-mobile/hc-client";
import type { ConnectionManager } from "../../net/connection.ts";
import type { ConnectionState } from "../../store/core.ts";
import type { TerminalModel } from "../../terminal/model.ts";
import type { ScreenSnapshot } from "../../terminal/snapshot.ts";

export type AttachmentStream = Pick<AttachHandle, "closed" | "consume" | "detach">;

export type AttachmentManager = Pick<ConnectionManager, "state" | "subscribe"> & {
  attach: (...args: Parameters<ConnectionManager["attach"]>) => Promise<AttachmentStream>;
};

export interface TerminalLifecycle {
  state: string;
  pid?: number | null;
}

export type AttachmentMode = "watching" | "control";
export type AttachmentPhase = "connecting" | "connected" | "closed" | "error";

export interface AttachmentState {
  snapshot: ScreenSnapshot;
  mode: AttachmentMode;
  phase: AttachmentPhase;
  error?: string;
}

interface AttachmentPlan {
  observe: boolean;
  cols: number;
  rows: number;
}

type Listener = (state: AttachmentState) => void;

/** Own one terminal model and preserve it while its stream reconnects or changes mode. */
export class AttachmentSession {
  private readonly manager: AttachmentManager;
  private readonly address: string;
  private readonly model: TerminalModel;
  private readonly listeners = new Set<Listener>();
  private stateValue: AttachmentState;
  private plan: AttachmentPlan;
  private handle: AttachmentStream | undefined;
  private unsubscribeManager: (() => void) | undefined;
  private started = false;
  private detached = false;
  private disposed = false;
  private attachPending = false;
  private detachPending = false;
  private generation = 0;
  private terminalLifecycle: TerminalLifecycle;
  private attachedPid: number | null | undefined;
  private restartPending = false;

  constructor(
    manager: AttachmentManager,
    address: string,
    model: TerminalModel,
    initialSize: { cols: number; rows: number },
    initialLifecycle: TerminalLifecycle = { state: "live" },
  ) {
    this.manager = manager;
    this.address = address;
    this.model = model;
    this.plan = { observe: true, ...initialSize };
    this.terminalLifecycle = initialLifecycle;
    this.attachedPid = initialLifecycle.pid;
    this.stateValue = {
      snapshot: model.snapshot(),
      mode: "watching",
      phase: "connecting",
    };
  }

  getState(): AttachmentState {
    return this.stateValue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.detached || this.disposed) return;
    this.started = true;
    this.unsubscribeManager = this.manager.subscribe((state) => this.onConnectionState(state));
  }

  resize(cols: number, rows: number): void {
    if (this.detached || this.disposed || cols < 1 || rows < 1) return;
    this.model.resize(cols, rows);
    this.update({ snapshot: this.model.snapshot() });
    if (this.stateValue.mode === "watching" && this.plan.observe) {
      this.plan = { observe: true, cols, rows };
    }
  }

  updateTerminalLifecycle(next: TerminalLifecycle): void {
    if (this.disposed || this.detached) return;
    const previous = this.terminalLifecycle;
    this.terminalLifecycle = next;
    const hasNewShell =
      next.state === "live" &&
      typeof next.pid === "number" &&
      (previous.state !== "live" || previous.pid !== next.pid);
    if (hasNewShell) {
      this.restartPending = true;
      this.attachRestartedShell();
    }
  }

  async takeOver(cols: number, rows: number): Promise<void> {
    if (this.disposed || this.detached) throw new Error("Attachment has ended");
    if (this.manager.state() !== "connected") throw new Error("Connection is not connected");
    if (this.attachPending) throw new Error("Attachment is still connecting");

    this.update({ phase: "connecting", error: undefined });
    const previous = this.handle;
    this.handle = undefined;
    this.plan = { observe: false, cols, rows };
    if (previous) await previous.detach().catch(() => undefined);
    if (this.disposed || this.detached) return;
    this.model.resize(cols, rows);
    this.update({ snapshot: this.model.snapshot() });
    const attached = await this.attach(this.plan);
    if (!attached) {
      throw new Error(this.stateValue.error ?? "Could not take control of the terminal");
    }
  }

  async detach(): Promise<void> {
    this.detached = true;
    const previous = this.handle;
    this.handle = undefined;
    this.generation += 1;
    this.update({ phase: "closed" });
    if (previous) await previous.detach().catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.detached = true;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribeManager?.();
    this.unsubscribeManager = undefined;
    const previous = this.handle;
    this.handle = undefined;
    if (previous) void previous.detach().catch(() => undefined);
    this.model.dispose();
    this.listeners.clear();
  }

  private onConnectionState(state: ConnectionState): void {
    if (this.disposed || this.detached) return;
    if (state === "connected") {
      if (this.restartPending) {
        this.attachRestartedShell();
        return;
      }
      if (this.handle || this.attachPending) return;
      void this.attach(this.plan);
      return;
    }

    if (this.attachPending) this.generation += 1;
    this.update({
      phase: state === "connecting" || state === "reconnecting" ? "connecting" : "closed",
    });
  }

  private async attach(plan: AttachmentPlan): Promise<boolean> {
    if (
      this.disposed ||
      this.detached ||
      !this.started ||
      this.attachPending ||
      this.manager.state() !== "connected"
    ) {
      return false;
    }

    this.attachPending = true;
    this.plan = plan;
    const operation = ++this.generation;
    const shellPid = this.terminalLifecycle.pid;
    this.update({ phase: "connecting", error: undefined });

    let attachedHandle: AttachmentStream | undefined;
    let pendingCredit = 0;
    try {
      const handle = await this.manager.attach(this.address, {
        observe: plan.observe,
        cols: plan.cols,
        rows: plan.rows,
        onData: (bytes) => {
          if (this.disposed || this.detached) return;
          this.model.write(bytes, () => {
            if (this.disposed || this.detached) return;
            this.update({ snapshot: this.model.snapshot() });
            if (attachedHandle) attachedHandle.consume(bytes.byteLength);
            else pendingCredit += bytes.byteLength;
          });
        },
      });
      attachedHandle = handle;

      if (this.disposed || this.detached || operation !== this.generation) {
        await handle.detach().catch(() => undefined);
        return false;
      }

      this.handle = handle;
      this.attachedPid = shellPid;
      this.restartPending =
        this.terminalLifecycle.state === "live" &&
        typeof this.terminalLifecycle.pid === "number" &&
        this.attachedPid !== this.terminalLifecycle.pid;
      if (pendingCredit > 0) handle.consume(pendingCredit);
      this.update({
        mode: plan.observe ? "watching" : "control",
        phase: "connected",
        error: undefined,
      });
      void handle.closed.then((end) => this.onStreamClosed(handle, end));
      return true;
    } catch (cause) {
      if (this.disposed || operation !== this.generation) return false;
      this.update({
        phase: "error",
        error: cause instanceof Error ? cause.message : "Attachment failed",
      });
      return false;
    } finally {
      this.attachPending = false;
      if (
        !this.disposed &&
        !this.detached &&
        operation !== this.generation &&
        !this.handle &&
        this.manager.state() === "connected"
      ) {
        const nextPlan = this.plan;
        queueMicrotask(() => void this.attach(nextPlan));
      }
      if (
        !this.disposed &&
        !this.detached &&
        this.restartPending &&
        this.terminalLifecycle.pid !== shellPid
      ) {
        queueMicrotask(() => this.attachRestartedShell());
      }
    }
  }

  private onStreamClosed(handle: AttachmentStream, end: StreamEnd): void {
    if (this.disposed || this.detached || this.handle !== handle) return;
    this.handle = undefined;
    this.update({ phase: "closed" });
    if (end.kind === "transport" && this.manager.state() === "connected") {
      void this.attach(this.plan);
      return;
    }
    if (this.restartPending) this.attachRestartedShell();
  }

  private attachRestartedShell(): void {
    if (
      !this.restartPending ||
      this.disposed ||
      this.detached ||
      !this.started ||
      this.manager.state() !== "connected" ||
      this.terminalLifecycle.state !== "live" ||
      typeof this.terminalLifecycle.pid !== "number" ||
      this.attachPending ||
      this.detachPending
    ) {
      return;
    }

    if (this.handle && this.attachedPid !== this.terminalLifecycle.pid) {
      const previous = this.handle;
      this.handle = undefined;
      this.detachPending = true;
      void previous
        .detach()
        .catch(() => undefined)
        .finally(() => {
          this.detachPending = false;
          this.update({ phase: "closed" });
          this.attachRestartedShell();
        });
      return;
    }
    if (this.handle) return;

    void this.attach(this.plan);
  }

  private update(patch: Partial<AttachmentState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    for (const listener of this.listeners) listener(this.stateValue);
  }
}
