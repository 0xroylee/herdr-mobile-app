/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { AttachOptions, StreamEnd } from "@herdr-mobile/hc-client";
import type { ConnectionState } from "../../store/core.ts";
import type { TerminalModel } from "../../terminal/model.ts";
import type { ScreenSnapshot } from "../../terminal/snapshot.ts";
import { type AttachmentManager, AttachmentSession, type AttachmentStream } from "./attachment.ts";

class FakeModel implements TerminalModel {
  cols: number;
  rows: number;
  readonly completions: (() => void)[] = [];
  disposed = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  write(_bytes: Uint8Array, done: () => void): void {
    this.completions.push(done);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  snapshot(): ScreenSnapshot {
    return {
      cols: this.cols,
      rows: Array.from({ length: this.rows }, () => []),
      cursor: { x: 0, y: 0, visible: true },
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  finishWrites(): void {
    for (const complete of this.completions.splice(0)) complete();
  }
}

class FakeStream implements AttachmentStream {
  readonly consumed: number[] = [];
  readonly closed: Promise<StreamEnd>;
  detachCount = 0;
  private finish!: (end: StreamEnd) => void;
  private detached = false;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  consume(byteCount: number): void {
    this.consumed.push(byteCount);
  }

  detach(): Promise<StreamEnd> {
    if (!this.detached) {
      this.detached = true;
      this.detachCount += 1;
      this.finish({ kind: "detached" });
    }
    return Promise.resolve({ kind: "detached" });
  }

  closeTransport(): void {
    this.finish({ kind: "transport" });
  }

  closeProgram(): void {
    this.finish({ kind: "program", reason: "signaled" });
  }
}

class FakeManager implements AttachmentManager {
  currentState: ConnectionState = "connected";
  readonly calls: {
    address: string;
    options: AttachOptions & { observe: boolean; cols: number; rows: number };
    stream: FakeStream;
  }[] = [];
  private readonly listeners = new Set<(state: ConnectionState) => void>();

  attach(
    address: string,
    options: AttachOptions & { observe: boolean; cols: number; rows: number },
  ): Promise<AttachmentStream> {
    const stream = new FakeStream();
    this.calls.push({ address, options, stream });
    options.onData(new Uint8Array([7, 8, 9]));
    return Promise.resolve(stream);
  }

  state(): ConnectionState {
    return this.currentState;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  setState(state: ConnectionState): void {
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
    if (state !== "connected") {
      for (const { stream } of this.calls) stream.closeTransport();
    }
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("agent attachment session", () => {
  test("observes at the terminal's size and returns credit after rendering", async () => {
    const manager = new FakeManager();
    const model = new FakeModel(132, 42);
    const session = new AttachmentSession(manager, "machine/t7", model, { cols: 132, rows: 42 });
    session.start();
    await settle();

    expect(manager.calls[0]?.address).toBe("machine/t7");
    expect(manager.calls[0]?.options).toMatchObject({
      observe: true,
      cols: 132,
      rows: 42,
    });
    expect(manager.calls[0]?.stream.consumed).toEqual([]);

    model.finishWrites();
    expect(manager.calls[0]?.stream.consumed).toEqual([3]);
    expect(session.getState().snapshot.cols).toBe(132);

    session.dispose();
  });

  test("resizes the model and re-attaches without observe at the pane size on takeover", async () => {
    const manager = new FakeManager();
    const model = new FakeModel(120, 36);
    const session = new AttachmentSession(manager, "t3", model, { cols: 120, rows: 36 });
    session.start();
    await settle();

    session.resize(100, 30);
    expect(model.cols).toBe(100);
    expect(model.rows).toBe(30);

    await session.takeOver(58, 22);

    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[1]?.options).toMatchObject({
      observe: false,
      cols: 58,
      rows: 22,
    });
    expect(manager.calls[0]?.stream.detachCount).toBe(1);
    expect(session.getState().mode).toBe("control");
    expect(model.cols).toBe(58);
    expect(model.rows).toBe(22);

    session.dispose();
  });

  test("reattaches with the active mode after the connection reconnects", async () => {
    const manager = new FakeManager();
    const model = new FakeModel(120, 36);
    const session = new AttachmentSession(manager, "t3", model, { cols: 120, rows: 36 });
    session.start();
    await settle();
    await session.takeOver(58, 22);

    manager.setState("reconnecting");
    manager.setState("connected");
    await settle();

    expect(manager.calls).toHaveLength(3);
    expect(manager.calls[2]?.options).toMatchObject({
      observe: false,
      cols: 58,
      rows: 22,
    });
    expect(session.getState().phase).toBe("connected");

    session.dispose();
    expect(model.disposed).toBe(true);
  });

  test("reattaches after a kept terminal restarts and preserves watching or control mode", async () => {
    const manager = new FakeManager();
    const model = new FakeModel(120, 36);
    const session = new AttachmentSession(
      manager,
      "t3",
      model,
      { cols: 120, rows: 36 },
      { state: "live", pid: 10 },
    );
    session.start();
    await settle();

    session.updateTerminalLifecycle({ state: "live", pid: null });
    manager.calls[0]?.stream.closeProgram();
    session.updateTerminalLifecycle({ state: "live", pid: 11 });
    await settle();

    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[1]?.options.observe).toBe(true);
    expect(session.getState().mode).toBe("watching");

    await session.takeOver(58, 22);
    session.updateTerminalLifecycle({ state: "live", pid: null });
    manager.calls[2]?.stream.closeProgram();
    session.updateTerminalLifecycle({ state: "live", pid: 12 });
    await settle();

    expect(manager.calls).toHaveLength(4);
    expect(manager.calls[3]?.options.observe).toBe(false);
    expect(session.getState().mode).toBe("control");
    session.dispose();
  });

  test("does not re-attach after the screen detaches on back navigation", async () => {
    const manager = new FakeManager();
    const model = new FakeModel(120, 36);
    const session = new AttachmentSession(manager, "t3", model, { cols: 120, rows: 36 });
    session.start();
    await settle();

    await session.detach();
    manager.setState("reconnecting");
    manager.setState("connected");
    await settle();

    expect(manager.calls).toHaveLength(1);
    session.dispose();
    expect(model.disposed).toBe(true);
  });
});
