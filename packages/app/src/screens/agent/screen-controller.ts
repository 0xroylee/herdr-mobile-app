import type { Status } from "@herdr-mobile/protocol";
import { useCallback, useState, useSyncExternalStore } from "react";
import { type AgentRow, deriveAgents } from "../../model/agents.ts";
import { getProgram, type ProgramInfo } from "../../model/program.ts";
import { type Prompt, recognizePrompt } from "../../model/prompt.ts";
import { isSeen, type SeenState } from "../../model/seen.ts";
import { type EffectiveState, effectiveState } from "../../model/status.ts";
import { formatAge } from "../../model/time.ts";
import type { MachineCoreState } from "../../store/core.ts";
import type { Machine } from "../../store/machines.ts";
import { type ScreenSnapshot, screenTextRows } from "../../terminal/snapshot.ts";
import type { TerminalFit } from "../../terminal/zoom.ts";
import type { AttachmentMode, AttachmentPhase } from "./attachment.ts";

export interface AgentCapabilities {
  canControl: boolean;
  readOnly: boolean;
  showMoreMenu: boolean;
  showKeyBar: boolean;
  showPromptChoices: boolean;
}

export function selectAgentCapabilities(role: Machine["role"] | undefined): AgentCapabilities {
  const canControl = role === "control";
  return {
    canControl,
    readOnly: !canControl,
    showMoreMenu: canControl,
    showKeyBar: canControl,
    showPromptChoices: canControl,
  };
}

export interface AgentScreenSelectionInput {
  address: string;
  activeId: string | null;
  machine?: Machine;
  machineCore?: MachineCoreState;
  seen: SeenState;
  now: number;
  snapshot: ScreenSnapshot;
  attachment: { mode: AttachmentMode; phase: AttachmentPhase };
}

export function selectTerminal(
  machineCore: MachineCoreState | undefined,
  address: string,
): AgentRow["terminal"] | undefined {
  return machineCore?.terminals[address];
}

export interface AgentScreenSelection extends AgentCapabilities {
  terminal: AgentRow["terminal"] | undefined;
  agentRow: AgentRow | undefined;
  state: EffectiveState;
  program: ProgramInfo;
  title: string;
  subtitle: string;
  prompt: Prompt | undefined;
  age: string;
  connected: boolean;
  showBanner: boolean;
  reconnecting: boolean;
  bannerMessage: string;
  placeholder: string | undefined;
  disabled: boolean;
}

export function selectAgentScreen(input: AgentScreenSelectionInput): AgentScreenSelection {
  const { address, activeId, machine, machineCore, seen, now, snapshot, attachment } = input;
  const terminal = selectTerminal(machineCore, address);
  const agentRow = selectAgentRow(machineCore, seen, activeId, address, now);
  const capabilities = selectAgentCapabilities(machine?.role);
  const statusSeen = activeId !== null && isSeen(seen, activeId, address, terminal?.turn);
  const state =
    agentRow?.state ??
    effectiveState(terminal?.status, { seen: statusSeen, terminalState: terminal?.state });
  const program: ProgramInfo =
    agentRow?.program ?? (terminal ? getProgram(terminal) : { name: "Terminal", iconKey: "bot" });
  const title =
    agentRow?.title ||
    terminal?.labels["herdr.tab"]?.trim() ||
    terminal?.title?.trim() ||
    terminal?.name?.trim() ||
    program.name;
  const subtitle =
    [agentRow?.space ?? terminal?.labels["herdr.space"]?.trim(), machine?.name]
      .filter((part): part is string => Boolean(part))
      .join(" · ") || "Connecting";
  const prompt = recognizePrompt(terminal?.status, screenTextRows(snapshot));
  const age =
    agentRow?.age ??
    formatAge(terminal?.status_ms ?? terminal?.finished_ms ?? terminal?.created_ms, now);
  const connected = machineCore?.connection === "connected" && attachment.phase === "connected";
  const terminalFinished =
    machineCore?.connection === "connected" && terminal?.state === "finished";
  const showBanner =
    machineCore?.connection !== "connected" ||
    attachment.phase === "error" ||
    attachment.phase === "closed" ||
    terminalFinished;
  const reconnecting =
    machineCore?.connection === "connecting" || machineCore?.connection === "reconnecting";
  const bannerMessage =
    machineCore?.connection === "unauthorized"
      ? "This device is no longer authorized."
      : machineCore?.connection === "connected"
        ? terminal?.state === "finished"
          ? finishedTerminalMessage(terminal)
          : "The terminal stream is unavailable."
        : reconnecting
          ? `Reconnecting to ${machine?.name ?? "machine"}…`
          : "Can't reach the bridge. Check that Tailscale is on.";
  const placeholder =
    terminal?.status?.state === "blocked" && !prompt ? `Answer ${program.name}…` : undefined;

  return {
    ...capabilities,
    terminal,
    agentRow,
    state,
    program,
    title,
    subtitle,
    prompt,
    age,
    connected,
    showBanner,
    reconnecting,
    bannerMessage,
    placeholder,
    disabled: !connected,
  };
}

function finishedTerminalMessage(terminal: NonNullable<AgentRow["terminal"]>): string {
  if (typeof terminal.exit_code === "number") {
    return `The program exited with code ${terminal.exit_code}.`;
  }
  if (typeof terminal.signal === "number") {
    const signalNames: Record<number, string> = {
      1: "SIGHUP",
      2: "SIGINT",
      3: "SIGQUIT",
      9: "SIGKILL",
      15: "SIGTERM",
    };
    return `The program was stopped by ${signalNames[terminal.signal] ?? `signal ${terminal.signal}`}.`;
  }
  return "The program has ended.";
}

function selectAgentRow(
  machineCore: MachineCoreState | undefined,
  seen: SeenState,
  machineId: string | null,
  address: string,
  now: number,
): AgentRow | undefined {
  if (!machineCore || !machineId) return undefined;
  return deriveAgents(
    machineCore.terminals,
    machineCore.layout,
    seen,
    machineId,
    now,
    "priority",
    (agent) => agent.address === address,
  )
    .flatMap((section) => section.agents)
    .find((agent) => agent.address === address);
}

export interface OpeningSeenMark {
  machineId: string;
  address: string;
  turn: number;
}

/** Marks only the turn visible when this machine/address becomes the open screen. */
export class OpeningSeenTracker {
  private machineId: string | null | undefined;
  private address: string | undefined;
  private marked = false;

  update(
    machineId: string | null,
    address: string,
    turn: number | undefined,
  ): OpeningSeenMark | undefined {
    if (this.machineId !== machineId || this.address !== address) {
      this.machineId = machineId;
      this.address = address;
      this.marked = false;
    }
    if (machineId === null || turn === undefined || this.marked) return undefined;
    this.marked = true;
    return { machineId, address, turn };
  }
}

export interface AutoTakeoverReadiness {
  requested: boolean;
  canControl: boolean;
  connected: boolean;
  fit: TerminalFit | undefined;
}

/** Starts a route-requested takeover once after its prerequisites become ready. */
export class AutoTakeoverController {
  private started = false;

  shouldStart(readiness: AutoTakeoverReadiness): boolean {
    if (
      this.started ||
      !readiness.requested ||
      !readiness.canControl ||
      !readiness.connected ||
      !readiness.fit ||
      readiness.fit.cols < 1 ||
      readiness.fit.rows < 1
    ) {
      return false;
    }
    this.started = true;
    return true;
  }
}

export interface ActionSnapshot {
  error: string | undefined;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Holds screen action errors and converts thrown effects into renderable results. */
export class AgentActionController {
  private snapshot: ActionSnapshot = { error: undefined };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): ActionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async run<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
    this.setError(undefined);
    try {
      return { ok: true, value: await action() };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Action failed";
      this.setError(error);
      return { ok: false, error };
    }
  }

  private setError(error: string | undefined): void {
    if (this.snapshot.error === error) return;
    this.snapshot = { error };
    for (const listener of this.listeners) listener();
  }
}

export function useAgentActionController() {
  const [controller] = useState(() => new AgentActionController());
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const run = useCallback(<T>(action: () => Promise<T>) => controller.run(action), [controller]);
  return { error: snapshot.error, run };
}

/** Updates seen storage through an injected adapter; screens supply the persistent store action. */
export function markOpeningTurnSeen(
  tracker: OpeningSeenTracker,
  machineId: string | null,
  address: string,
  turn: number | undefined,
  mark: (machineId: string, address: string, turn: number) => void,
): void {
  const opening = tracker.update(machineId, address, turn);
  if (opening) mark(opening.machineId, opening.address, opening.turn);
}

export type CurrentStatus = Status | null | undefined;
