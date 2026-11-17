import type { HcEvent, JsonValue, Status, Terminal } from "@herdr-mobile/protocol";

interface StepAt {
  t: number;
  address: string;
}

export type ModelStep = StepAt &
  (
    | { kind: "create"; argv: string[]; cwd: string; labels: Record<string, string>; pid: number }
    | { kind: "report"; status: Status }
    | { kind: "exit"; code: number | null; signal: number | null; keep: boolean }
    | { kind: "remove" }
    | { kind: "restart"; pid: number }
    | { kind: "meta"; labels: Record<string, string> }
  );

export interface ModelEvent {
  event: HcEvent;
  /** Consistent state revealed by the event; status and turn share that state. */
  revealed?: Terminal;
}

export class ModelCore {
  private readonly terminals = new Map<string, Terminal>();
  private seq = 0;

  snapshot(): Terminal[] {
    return [...this.terminals.values()].map((terminal) => ({ ...terminal }));
  }

  apply(step: ModelStep, emitNullStatus = true): ModelEvent[] {
    if (step.kind === "create") {
      const terminal: Terminal = {
        address: step.address,
        argv: [...step.argv],
        cols: 80,
        created_ms: step.t,
        cwd: step.cwd,
        exit_code: null,
        finished_ms: null,
        labels: { ...step.labels },
        pid: step.pid,
        reason: null,
        rows: 24,
        screen: "",
        signal: null,
        state: "live",
        status: null,
        status_ms: null,
        reported: false,
        turn: 0,
      };
      this.terminals.set(step.address, terminal);
      return [this.emit("created", step.address, terminal, terminal)];
    }

    const terminal = this.terminals.get(step.address);
    if (terminal === undefined) return [];

    if (step.kind === "report") {
      const turn =
        (terminal.turn ?? 0) +
        (terminal.status?.state === "working" && step.status.state !== "working" ? 1 : 0);
      const next: Terminal = {
        ...terminal,
        status: step.status,
        status_ms: step.t,
        reported: true,
        turn,
      };
      this.terminals.set(step.address, next);
      const events = [
        this.emit(
          "status",
          step.address,
          { status: step.status, records: next.records ?? {}, reported: true },
          next,
        ),
      ];
      if (turn !== (terminal.turn ?? 0)) {
        events.push(this.emit("turn", step.address, { turn }, next));
      }
      return events;
    }

    if (step.kind === "exit") {
      const reason = step.signal === null ? "exited" : "signaled";
      const { foreground: _foreground, ...withoutForeground } = terminal;
      const next: Terminal = {
        ...withoutForeground,
        status: null,
        status_ms: null,
        pid: null,
        reason,
        exit_code: step.code,
        signal: step.signal,
        finished_ms: step.keep ? null : step.t,
        state: step.keep ? "live" : "finished",
      };
      const events: ModelEvent[] = [];
      if (emitNullStatus) {
        const statusCleared = { ...terminal, status: null, status_ms: null };
        this.terminals.set(step.address, statusCleared);
        events.push(
          this.emit(
            "status",
            step.address,
            { status: null, records: next.records ?? {}, reported: next.reported ?? false },
            statusCleared,
          ),
        );
      }
      this.terminals.set(step.address, next);
      events.push(
        this.emit(
          step.keep ? "lost" : "finished",
          step.address,
          step.keep
            ? { reason, exit_code: step.code, signal: step.signal }
            : { reason, exit_code: step.code, signal: step.signal, finished_ms: step.t },
          next,
        ),
      );
      return events;
    }

    if (step.kind === "remove") {
      this.terminals.delete(step.address);
      return [this.emit("removed", step.address, {}, undefined)];
    }

    if (step.kind === "restart") {
      const next: Terminal = {
        ...terminal,
        pid: step.pid,
        status: null,
        status_ms: null,
        reported: false,
        turn: 0,
        reason: null,
        exit_code: null,
        signal: null,
        finished_ms: null,
        state: "live",
      };
      this.terminals.set(step.address, next);
      return [this.emit("restarted", step.address, next, next)];
    }

    const next = { ...terminal, labels: { ...step.labels } };
    this.terminals.set(step.address, next);
    return [this.emit("labels", step.address, { labels: next.labels }, next)];
  }

  private emit(type: string, address: string, data: unknown, revealed?: Terminal): ModelEvent {
    return {
      event: {
        seq: ++this.seq,
        type,
        terminal: address,
        data: data as JsonValue,
      },
      ...(revealed === undefined ? {} : { revealed }),
    };
  }
}
