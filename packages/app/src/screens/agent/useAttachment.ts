import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionManager } from "../../net/connection.ts";
import { createTerminalModel } from "../../terminal/model.ts";
import type { ScreenSnapshot } from "../../terminal/snapshot.ts";
import {
  type AttachmentMode,
  type AttachmentPhase,
  AttachmentSession,
  type TerminalLifecycle,
} from "./attachment.ts";

export interface AttachmentView {
  snapshot: ScreenSnapshot;
  mode: AttachmentMode;
  phase: AttachmentPhase;
  error?: string;
  takeOver(cols: number, rows: number): Promise<void>;
  detach(): Promise<void>;
}

const EMPTY_SNAPSHOT: ScreenSnapshot = {
  cols: 80,
  rows: Array.from({ length: 24 }, () => []),
  cursor: { x: 0, y: 0, visible: true },
};

/** Connect the React view to the testable terminal attachment session. */
export function useAttachment(
  manager: ConnectionManager | undefined,
  address: string,
  enabled: boolean,
  cols: number,
  rows: number,
  lifecycle: TerminalLifecycle = { state: "live" },
): AttachmentView {
  const [state, setState] = useState({
    snapshot: EMPTY_SNAPSHOT,
    mode: "watching" as AttachmentMode,
    phase: "connecting" as AttachmentPhase,
  });
  const sessionRef = useRef<AttachmentSession | undefined>(undefined);
  const initialSizeRef = useRef({ cols, rows });
  const identityRef = useRef({ manager, address });
  const lifecycleRef = useRef(lifecycle);
  const terminalState = lifecycle.state;
  const terminalPid = lifecycle.pid;
  lifecycleRef.current = lifecycle;

  if (identityRef.current.manager !== manager || identityRef.current.address !== address) {
    identityRef.current = { manager, address };
    initialSizeRef.current = { cols, rows };
  } else if (!enabled || manager === undefined) {
    initialSizeRef.current = { cols, rows };
  }

  useEffect(() => {
    if (!enabled || !manager) {
      setState((current) => ({ ...current, phase: "closed", error: undefined }));
      return;
    }

    const initialSize = initialSizeRef.current;
    const session = new AttachmentSession(
      manager,
      address,
      createTerminalModel(initialSize.cols, initialSize.rows),
      initialSize,
      lifecycleRef.current,
    );
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setState);
    session.start();

    return () => {
      unsubscribe();
      if (sessionRef.current === session) sessionRef.current = undefined;
      session.dispose();
    };
  }, [enabled, manager, address]);

  useEffect(() => {
    sessionRef.current?.updateTerminalLifecycle({ state: terminalState, pid: terminalPid });
  }, [terminalPid, terminalState]);

  useEffect(() => {
    sessionRef.current?.resize(cols, rows);
  }, [cols, rows]);

  const takeOver = useCallback(async (nextCols: number, nextRows: number) => {
    const session = sessionRef.current;
    if (!session) throw new Error("Terminal is not attached");
    await session.takeOver(nextCols, nextRows);
  }, []);

  const detach = useCallback(async () => {
    await sessionRef.current?.detach();
  }, []);

  return { ...state, takeOver, detach };
}
