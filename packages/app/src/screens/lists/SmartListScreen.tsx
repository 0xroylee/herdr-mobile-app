import type { Status } from "@herdr-mobile/protocol";
import { summarize } from "@herdr-mobile/protocol";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { LinearTransition, useReducedMotion } from "react-native-reanimated";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { promptKey, recognizePrompt } from "../../model/prompt.ts";
import { SENT_TIMEOUT_MS } from "../../model/sent.ts";
import { deriveTasks, type TaskRow as TaskRowModel } from "../../model/tasks.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import type { ScreenText } from "../../net/screen-text.ts";
import { createScreenText } from "../../net/screen-text.ts";
import type { TaskActions } from "../../net/task-actions.ts";
import { createTaskActions } from "../../net/task-actions.ts";
import { routes, type SmartListKind } from "../../routes.ts";
import type { ConnectionState } from "../../store/core.ts";
import { coreStore, machinesStore } from "../../store/platform.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { SectionHeader } from "../../ui/components/SectionHeader.tsx";
import { Tag } from "../../ui/components/Tag.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { KeyQueue } from "../agent/key-queue.ts";
import { PromptAnswer } from "../agent/prompt-answer.ts";
import { ConnectionBanner } from "../home/ConnectionBanner.tsx";
import { connectionPresentation } from "../home/connectionPresentation.ts";
import {
  type CheckOffChoice,
  type CheckOffCurrent,
  checkOffSheetOptionsFor,
  runCheckOff as runCheckOffAction,
  type TaskIdentity,
} from "../project/check-off.ts";
import {
  cacheTaskSummaryReadByMachine,
  shouldReadTaskSummary,
  type TaskSummaryRow,
  taskSummary,
  taskSummaryKey,
} from "../project/project-view.ts";
import { TaskCircle } from "../project/TaskCircle.tsx";
import {
  answerKeysForChoice,
  canFollowUpTask,
  canSwipeListActions,
  canUseSmartListActions,
  checkOffVisibleRows,
  DONE_ROW_DISMISS_MS,
  type DoneRowRemoval,
  finishDoneRowCheck,
  finishDoneRowDismissal,
  groupNeedsYouRows,
  holdDoneRowForRemoval,
  InlinePromptAnswers,
  removalMatchesCurrentTurn,
  shouldClearDoneRowRemoval,
  smartListRows,
  taskDetailForList,
  taskDetailTone,
} from "./lists-view.ts";

const emptyTasks: Record<string, never> = {};
const emptyLastSeen = {};
const rowLayout = LinearTransition.duration(220);
const listTitles: Record<SmartListKind, string> = {
  "needs-you": "Needs you",
  running: "Running",
  done: "Done",
};

interface DisplayRow {
  row: TaskRowModel;
  summary?: string;
  checkingOff: boolean;
  dimmed: boolean;
}

export function SmartListScreen() {
  const params = useLocalSearchParams<{ kind?: string | string[] }>();
  const router = useRouter();
  const manager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const requestedKind = firstParam(params.kind);
  const kind: SmartListKind = isSmartListKind(requestedKind) ? requestedKind : "needs-you";
  const connection = core?.connection ?? "offline";
  const presentation = connectionPresentation(connection, machine?.name);
  const canWrite = canUseSmartListActions(machine?.role, connection);
  const reducedMotion = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  const [summariesByMachine, setSummariesByMachine] = useState<
    Record<string, Record<string, string>>
  >({});
  const requestedSummaries = useRef(new Set<string>());
  const [message, setMessage] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [checkTask, setCheckTask] = useState<TaskIdentity>();
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [pendingRemovals, setPendingRemovals] = useState<Record<string, DoneRowRemoval>>({});
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const previousActiveId = useRef(activeId);
  const summaryScope = activeId ?? "none";
  const summaries = summariesByMachine[summaryScope] ?? {};

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    previousActiveId.current = activeId;
    setMessage(undefined);
    setMenuOpen(false);
    setCheckTask(undefined);
  }, [activeId]);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const taskRows = useMemo(
    () =>
      deriveTasks(
        core?.tasks?.tasks ?? emptyTasks,
        core?.terminals ?? {},
        core?.layout,
        core?.lastSeenStatuses ?? emptyLastSeen,
        now,
      ),
    [core?.lastSeenStatuses, core?.layout, core?.tasks, core?.terminals, now],
  );
  const rows = useMemo(() => smartListRows(kind, taskRows.rows), [kind, taskRows.rows]);
  const groups = useMemo(
    () => groupNeedsYouRows(taskRows.rows, core?.layout?.spaces.map((space) => space.id) ?? []),
    [core?.layout?.spaces, taskRows.rows],
  );
  const actions = useMemo(
    () =>
      createTaskActions(
        manager,
        manager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
      ),
    [manager],
  );
  const screenText = useMemo(
    () => (manager === undefined ? undefined : createScreenText(manager)),
    [manager],
  );

  const summaryRow = useCallback(
    (row: TaskRowModel): TaskSummaryRow => ({
      ...row,
      lastSeenStatus: row.address === undefined ? undefined : core?.lastSeenStatuses?.[row.address],
    }),
    [core?.lastSeenStatuses],
  );
  const clearPendingRemoval = useCallback((identity: TaskIdentity) => {
    const key = taskIdentityKey(identity.machineId, identity.taskId);
    const timer = removalTimers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    removalTimers.current.delete(key);
    setPendingRemovals((previous) => {
      if (previous[key] === undefined) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    if (kind !== "done" || screenText === undefined || connection !== "connected") return;
    for (const sourceRow of rows) {
      const row = summaryRow(sourceRow);
      if (!shouldReadTaskSummary(row, summaries) || row.address === undefined) continue;
      const address = row.address;
      const key = taskSummaryKey(row);
      const scopedKey = `${summaryScope}\u0000${key}`;
      if (requestedSummaries.current.has(scopedKey)) continue;
      requestedSummaries.current.add(scopedKey);
      void screenText
        .read(address, { turn: row.terminal?.turn, state: row.terminal?.status?.state })
        .then((screenRows) => {
          if (machinesStore.getState().activeId !== activeId) return;
          const terminal = coreStore.getState().machines[activeId ?? ""]?.terminals[address];
          setSummariesByMachine((previous) =>
            cacheTaskSummaryReadByMachine(
              previous,
              summaryScope,
              row,
              terminal,
              summarize(row.program.iconKey, undefined, screenRows),
            ),
          );
        })
        .catch(() => {
          if (machinesStore.getState().activeId !== activeId) return;
          setSummariesByMachine((previous) => ({
            ...previous,
            [summaryScope]: { ...previous[summaryScope], [key]: "No summary yet." },
          }));
        });
    }
  }, [activeId, connection, kind, rows, screenText, summaries, summaryScope, summaryRow]);

  useEffect(() => {
    if (kind !== "done") return;
    const visibleDoneTaskIds = new Set(rows.map((row) => row.id));
    for (const pending of Object.values(pendingRemovals)) {
      if (
        pending.machineId === activeId &&
        shouldClearDoneRowRemoval(pending, taskRows.taskFor(pending.row.id), visibleDoneTaskIds)
      ) {
        clearPendingRemoval({ machineId: pending.machineId, taskId: pending.row.id });
      }
    }
  }, [activeId, clearPendingRemoval, kind, pendingRemovals, rows, taskRows]);

  const listSummary = useCallback(
    (row: TaskRowModel) => taskSummary(summaryRow(row), summaries) ?? "No summary yet.",
    [summaries, summaryRow],
  );

  const displayRows = useMemo((): DisplayRow[] => {
    const displayed = new Map<string, DisplayRow>();
    for (const row of rows) {
      const rowKey = activeId === null ? undefined : taskIdentityKey(activeId, row.id);
      const storedPending = rowKey === undefined ? undefined : pendingRemovals[rowKey];
      const currentRow = taskRows.taskFor(row.id) ?? row;
      const pending =
        storedPending !== undefined && removalMatchesCurrentTurn(currentRow, storedPending)
          ? storedPending
          : undefined;
      if (pending?.leaveAfter) continue;
      displayed.set(row.id, {
        row: pending?.checkedAt === undefined ? row : pending.row,
        summary: pending?.summary ?? (kind === "done" ? listSummary(row) : undefined),
        checkingOff: rowKey === undefined ? false : busyTaskIds.has(rowKey),
        dimmed: pending?.checkedAt !== undefined,
      });
    }
    if (kind === "done") {
      for (const pending of Object.values(pendingRemovals)) {
        const currentRow = taskRows.taskFor(pending.row.id);
        if (
          pending.machineId !== activeId ||
          pending.leaveAfter ||
          displayed.has(pending.row.id) ||
          (currentRow !== undefined && !removalMatchesCurrentTurn(currentRow, pending))
        )
          continue;
        const key = taskIdentityKey(pending.machineId, pending.row.id);
        displayed.set(pending.row.id, {
          row: pending.row,
          summary: pending.summary,
          checkingOff: busyTaskIds.has(key),
          dimmed: pending.checkedAt !== undefined,
        });
      }
    }
    return [...displayed.values()].sort((left, right) =>
      kind === "done"
        ? right.row.timestamp - left.row.timestamp ||
          right.row.createdAt - left.row.createdAt ||
          left.row.id.localeCompare(right.row.id)
        : 0,
    );
  }, [activeId, busyTaskIds, kind, listSummary, pendingRemovals, rows, taskRows]);

  const openTask = (id: string) => router.push(routes.task(id) as Href);
  const goHome = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.home as Href);
  };

  function latestTaskRow(identity: TaskIdentity): TaskRowModel | undefined {
    if (machinesStore.getState().activeId !== identity.machineId) return undefined;
    const latestCore = coreStore.getState().machines[identity.machineId];
    return deriveTasks(
      latestCore?.tasks?.tasks ?? emptyTasks,
      latestCore?.terminals ?? {},
      latestCore?.layout,
      latestCore?.lastSeenStatuses ?? emptyLastSeen,
      Date.now(),
    ).taskFor(identity.taskId);
  }

  function currentCheckOff(identity: TaskIdentity): CheckOffCurrent {
    const machineState = machinesStore.getState();
    const activeMachineId = machineState.activeId;
    const currentCore =
      activeMachineId === null ? undefined : coreStore.getState().machines[activeMachineId];
    const currentRows =
      activeMachineId === null || currentCore === undefined
        ? undefined
        : deriveTasks(
            currentCore.tasks?.tasks ?? emptyTasks,
            currentCore.terminals,
            currentCore.layout,
            currentCore.lastSeenStatuses ?? emptyLastSeen,
            Date.now(),
          );
    return {
      activeMachineId,
      role: activeMachineId === null ? undefined : machineState.machines[activeMachineId]?.role,
      connection: currentCore?.connection,
      row: currentRows?.taskFor(identity.taskId),
    };
  }

  function holdDoneRow(identity: TaskIdentity, row: TaskRowModel): void {
    const key = taskIdentityKey(identity.machineId, identity.taskId);
    setPendingRemovals((previous) => ({
      ...previous,
      [key]: holdDoneRowForRemoval(identity.machineId, row, listSummary(row)),
    }));
  }

  function finishDoneRow(identity: TaskIdentity, row: TaskRowModel): void {
    const key = taskIdentityKey(identity.machineId, identity.taskId);
    const checkedAt = Date.now();
    const summary = listSummary(row);
    setPendingRemovals((previous) => ({
      ...previous,
      [key]: finishDoneRowCheck(
        holdDoneRowForRemoval(identity.machineId, row, summary),
        checkedAt,
        reducedMotion,
      ),
    }));
    if (reducedMotion) return;
    const timer = setTimeout(() => {
      removalTimers.current.delete(key);
      setPendingRemovals((previous) => {
        const pending = previous[key];
        if (pending === undefined) return previous;
        const finished = finishDoneRowDismissal(pending, Date.now());
        return finished === undefined ? previous : { ...previous, [key]: finished };
      });
    }, DONE_ROW_DISMISS_MS);
    removalTimers.current.set(key, timer);
  }

  async function runCheckOff(
    identity: TaskIdentity,
    choice?: CheckOffChoice,
    displayRow?: TaskRowModel,
  ): Promise<"refused" | "ask" | "checked"> {
    const sourceRow = latestTaskRow(identity) ?? displayRow;
    const busyKey = taskIdentityKey(identity.machineId, identity.taskId);
    if (sourceRow?.state === "done" || sourceRow?.state === "stopped") {
      holdDoneRow(identity, sourceRow);
    }
    setBusyTaskIds((previous) => new Set(previous).add(busyKey));
    setMessage(undefined);
    try {
      const result = await runCheckOffAction(identity, choice, {
        current: () => currentCheckOff(identity),
        actions,
      });
      if (machinesStore.getState().activeId !== identity.machineId) return result;
      if (result === "ask") {
        if (sourceRow?.state === "done" || sourceRow?.state === "stopped") {
          clearPendingRemoval(identity);
        }
        setCheckTask(identity);
      } else if (result === "checked") {
        setCheckTask(undefined);
        if (sourceRow?.state === "done" || sourceRow?.state === "stopped") {
          finishDoneRow(identity, sourceRow);
        }
      } else if (sourceRow?.state === "done" || sourceRow?.state === "stopped") {
        clearPendingRemoval(identity);
      }
      return result;
    } catch (error) {
      if (sourceRow?.state === "done" || sourceRow?.state === "stopped") {
        clearPendingRemoval(identity);
      }
      if (machinesStore.getState().activeId !== identity.machineId) return "refused";
      setMessage(error instanceof Error ? error.message : "Couldn't check off the task.");
      return "refused";
    } finally {
      setBusyTaskIds((previous) => {
        const next = new Set(previous);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function checkOffAll(): Promise<void> {
    setMenuOpen(false);
    if (activeId === null || !canWrite || checkingAll) return;
    setCheckingAll(true);
    const visibleRows = [...rows];
    try {
      const result = await checkOffVisibleRows(activeId, visibleRows, (identity) =>
        runCheckOff(
          identity,
          undefined,
          visibleRows.find((row) => row.id === identity.taskId),
        ),
      );
      if (result.result === "refused" && result.completed === 0) return;
    } finally {
      setCheckingAll(false);
    }
  }

  const checkTaskRow = checkTask === undefined ? undefined : latestTaskRow(checkTask);
  const checkOptions =
    checkTask === undefined || checkTaskRow === undefined
      ? []
      : checkOffSheetOptionsFor(
          checkTaskRow,
          checkTask.machineId,
          activeId,
          machine?.role,
          connection,
        );
  const showMenu = kind === "done" && canWrite && rows.length > 0;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View className="flex-1 bg-canvas px-3.5 pt-safe">
        <View className="min-h-11 flex-row items-center justify-between">
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-1"
            onPress={goHome}
          >
            <Icon color="muted" name="chevron-left" size={22} />
            <Text variant="button" tone="muted">
              Home
            </Text>
          </Pressable>
          {showMenu ? (
            <IconButton
              accessibilityLabel="More list options"
              icon="ellipsis"
              onPress={() => setMenuOpen(true)}
            />
          ) : (
            <View className="h-11 w-11" />
          )}
        </View>

        <ConnectionBanner presentation={presentation} />

        <ScrollView
          className="min-h-0 flex-1"
          contentContainerClassName="gap-3 pb-3"
          showsVerticalScrollIndicator={false}
        >
          <Text variant="pairTitle">{listTitles[kind]}</Text>
          <View style={presentation.dimmed ? { opacity: 0.6 } : undefined}>
            {kind === "needs-you" ? (
              <View className="gap-1">
                {groups.map((group) => (
                  <View key={group.project.id}>
                    <SectionHeader title={group.project.name} count={group.rows.length} />
                    <ListGroup>
                      {group.rows.map((row) => (
                        <NeedsYouTaskRow
                          actions={actions}
                          canAnswer={canWrite}
                          canCheckOff={
                            canWrite &&
                            !(
                              activeId !== null &&
                              busyTaskIds.has(taskIdentityKey(activeId, row.id))
                            )
                          }
                          checkingOff={
                            activeId !== null && busyTaskIds.has(taskIdentityKey(activeId, row.id))
                          }
                          key={`${activeId ?? "none"}:${row.id}`}
                          onCheckOff={() => {
                            if (activeId !== null)
                              void runCheckOff(
                                { machineId: activeId, taskId: row.id },
                                undefined,
                                row,
                              );
                          }}
                          onOpen={() => openTask(row.id)}
                          onOpenTerminal={(address) => router.push(routes.agent(address) as Href)}
                          row={row}
                          screenText={screenText}
                          terminalState={row.terminal?.status ?? undefined}
                          connection={connection}
                        />
                      ))}
                    </ListGroup>
                  </View>
                ))}
              </View>
            ) : displayRows.length > 0 ? (
              <ListGroup>
                {displayRows.map((item) => (
                  <Animated.View
                    key={`${activeId ?? "none"}:${item.row.id}`}
                    layout={reducedMotion ? undefined : rowLayout}
                    style={item.dimmed ? { opacity: 0.42 } : undefined}
                  >
                    {canSwipeListActions(kind, machine?.role, connection) ? (
                      <DoneSwipeRow
                        enabled={!item.checkingOff && !item.dimmed}
                        followUpEnabled={canFollowUpTask(item.row)}
                        onCheckOff={() => {
                          if (activeId !== null) {
                            void runCheckOff(
                              { machineId: activeId, taskId: item.row.id },
                              undefined,
                              item.row,
                            );
                          }
                        }}
                        onFollowUp={() =>
                          router.push({
                            pathname: "/task/[id]",
                            params: { id: item.row.id, focus: "followup" },
                          } as Href)
                        }
                      >
                        <SmartTaskRow
                          canCheckOff={canWrite && !item.checkingOff && !item.dimmed}
                          detail={taskDetailForList(kind, item.row, item.summary)}
                          detailTone={taskDetailTone(item.row)}
                          onCheckOff={() => {
                            if (activeId !== null) {
                              void runCheckOff(
                                { machineId: activeId, taskId: item.row.id },
                                undefined,
                                item.row,
                              );
                            }
                          }}
                          onOpen={() => openTask(item.row.id)}
                          row={item.row}
                          showProject
                          opaqueSurface
                        />
                      </DoneSwipeRow>
                    ) : (
                      <SmartTaskRow
                        canCheckOff={canWrite && !item.checkingOff}
                        detail={taskDetailForList(kind, item.row, item.summary)}
                        detailTone={taskDetailTone(item.row)}
                        onCheckOff={() => {
                          if (activeId !== null) {
                            void runCheckOff(
                              { machineId: activeId, taskId: item.row.id },
                              undefined,
                              item.row,
                            );
                          }
                        }}
                        onOpen={() => openTask(item.row.id)}
                        row={item.row}
                        showProject
                      />
                    )}
                  </Animated.View>
                ))}
              </ListGroup>
            ) : null}
          </View>

          {message ? (
            <Text accessibilityRole="alert" variant="caption" tone="blocked">
              {message}
            </Text>
          ) : null}
        </ScrollView>

        <ListMenu
          onCheckOffAll={() => void checkOffAll()}
          onClose={() => setMenuOpen(false)}
          visible={menuOpen && showMenu}
          busy={checkingAll}
        />
        <CheckOffSheet
          onChoose={(choice) => {
            if (checkTask !== undefined) void runCheckOff(checkTask, choice);
          }}
          onClose={() => setCheckTask(undefined)}
          options={checkOptions}
          visible={checkTask !== undefined && checkOptions.length > 0}
        />
      </View>
    </GestureHandlerRootView>
  );
}

function NeedsYouTaskRow({
  actions,
  canAnswer,
  canCheckOff,
  checkingOff,
  connection,
  onCheckOff,
  onOpen,
  onOpenTerminal,
  row,
  screenText,
  terminalState,
}: {
  actions: TaskActions;
  canAnswer: boolean;
  canCheckOff: boolean;
  checkingOff: boolean;
  connection: ConnectionState;
  onCheckOff(): void;
  onOpen(): void;
  onOpenTerminal(address: string): void;
  row: TaskRowModel;
  screenText: ScreenText | undefined;
  terminalState: Status | null | undefined;
}) {
  const [screenRows, setScreenRows] = useState<readonly string[]>();
  const statusState = row.terminal?.status?.state;
  const statusMs = row.terminal?.status_ms;
  const turn = row.terminal?.turn;
  const address = row.address;
  const hasTerminal = row.terminal !== undefined;
  const [inlineAnswers] = useState(() => new InlinePromptAnswers(terminalState));
  const answerSnapshot = useSyncExternalStore(
    inlineAnswers.subscribe,
    inlineAnswers.getSnapshot,
    inlineAnswers.getSnapshot,
  );
  const [queue] = useState(() => new KeyQueue());
  const [answerer] = useState(() => new PromptAnswer(queue));
  const readVersion = `${turn ?? ""}:${statusState ?? ""}:${statusMs ?? ""}`;
  const latestReadVersion = useRef(readVersion);

  useEffect(() => {
    let active = true;
    latestReadVersion.current = readVersion;
    if (address === undefined || !hasTerminal) {
      setScreenRows(undefined);
      return () => {
        active = false;
      };
    }
    if (screenText === undefined || connection !== "connected") {
      return () => {
        active = false;
      };
    }
    setScreenRows(undefined);
    screenText.invalidate(address);
    void screenText
      .read(address, { turn, state: statusState })
      .then((result) => {
        if (active && latestReadVersion.current === readVersion) setScreenRows(result);
      })
      .catch(() => {
        if (active && latestReadVersion.current === readVersion) setScreenRows([]);
      });
    return () => {
      active = false;
    };
  }, [address, connection, hasTerminal, readVersion, screenText, statusState, turn]);

  useEffect(() => {
    inlineAnswers.setStatus(terminalState);
  }, [inlineAnswers, terminalState]);

  useEffect(() => {
    const sentAtValues = Object.values(answerSnapshot.sent);
    if (sentAtValues.length === 0) return;
    const remaining = Math.min(
      ...sentAtValues.map((sentAt) => Math.max(0, SENT_TIMEOUT_MS - (Date.now() - sentAt))),
    );
    const timer = setTimeout(() => inlineAnswers.expireSent(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [answerSnapshot.sent, inlineAnswers]);

  const prompt = useMemo(
    () => recognizePrompt(terminalState, screenRows ?? [], row.program.iconKey),
    [row.program.iconKey, screenRows, terminalState],
  );
  const currentPromptKey = prompt === undefined ? undefined : promptKey(prompt);
  const pendingAnswer =
    currentPromptKey !== undefined && answerSnapshot.pendingPromptKeys.has(currentPromptKey);
  const sent = inlineAnswers.isSent(currentPromptKey, terminalState, Date.now());
  const canSend = canAnswer && inlineAnswers.canAnswer(currentPromptKey, terminalState, Date.now());

  async function answer(keys: readonly string[]): Promise<void> {
    if (address === undefined || currentPromptKey === undefined) return;
    const key = currentPromptKey;
    await inlineAnswers.answer(
      key,
      terminalState,
      () =>
        answerer.answer(keys, async (sequence) => {
          await actions.haptic();
          await actions.answer(address, sequence);
          return true;
        }),
      () => Date.now(),
    );
  }

  const detail = prompt?.question ?? row.question;
  return (
    <SmartTaskRow
      canCheckOff={canCheckOff && !checkingOff}
      detail={detail}
      detailTone="muted"
      onCheckOff={onCheckOff}
      onOpen={onOpen}
      row={row}
    >
      {pendingAnswer ? (
        <Text style={{ marginTop: 8 }} variant="subhead" tone="muted">
          Sending…
        </Text>
      ) : sent ? (
        <Text style={{ marginTop: 8 }} variant="subhead" tone="done">
          Sent
        </Text>
      ) : prompt !== undefined ? (
        <View className="mt-1.5 flex-row flex-wrap gap-1.5">
          {prompt.choices.map((choice, index) => {
            const keys = answerKeysForChoice(prompt, index);
            const disabled = !canSend || pendingAnswer || keys === undefined;
            return (
              <Pressable
                key={`${currentPromptKey}:${choice.keys.join(",")}:${choice.label}`}
                accessibilityLabel={choice.label}
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                className={`min-h-11 justify-center rounded-btn border-border px-3 ${index === 0 ? "bg-solid" : "bg-surface"}`}
                disabled={disabled}
                onPress={() => {
                  if (keys !== undefined) void answer(keys);
                }}
                style={({ pressed }) => ({
                  borderWidth: HAIRLINE,
                  opacity: disabled ? 0.4 : pressed ? 0.82 : 1,
                })}
              >
                <Text variant="button" tone={index === 0 ? "solid-fg" : "fg"} numberOfLines={2}>
                  {choice.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : row.address !== undefined ? (
        <Pressable
          accessibilityRole="button"
          className="min-h-11 justify-center"
          disabled={!canAnswer}
          onPress={() => onOpenTerminal(address as string)}
          style={({ pressed }) => ({ opacity: canAnswer ? (pressed ? 0.7 : 1) : 0.4 })}
        >
          <Text style={{ marginTop: 8 }} variant="subhead" tone="muted">
            Open terminal to answer
          </Text>
        </Pressable>
      ) : (
        <Text style={{ marginTop: 8 }} variant="subhead" tone="muted">
          Open terminal to answer
        </Text>
      )}
    </SmartTaskRow>
  );
}

function SmartTaskRow({
  canCheckOff,
  children,
  detail,
  detailTone,
  onCheckOff,
  onOpen,
  opaqueSurface = false,
  row,
  showProject = false,
}: {
  canCheckOff: boolean;
  children?: ReactNode;
  detail: string | undefined;
  detailTone: "danger" | "muted";
  onCheckOff(): void;
  onOpen(): void;
  opaqueSurface?: boolean;
  row: TaskRowModel;
  showProject?: boolean;
}) {
  return (
    <View
      className={`flex-row items-start gap-3 px-1.5 py-2.5 ${opaqueSurface ? "bg-surface" : ""}`}
    >
      <View className="pt-0.5">
        <TaskCircle enabled={canCheckOff} onPress={onCheckOff} row={row} />
      </View>
      <View className="min-w-0 flex-1">
        <Pressable accessibilityRole="button" className="min-w-0" onPress={onOpen}>
          <Text
            numberOfLines={2}
            style={row.checked ? { textDecorationLine: "line-through" } : undefined}
            tone={row.checked ? "dim" : "fg"}
            variant="headline"
          >
            {row.title}
          </Text>
          <View className="mt-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
            {showProject ? <Text variant="caption">{row.project.name}</Text> : null}
            <ProgramIcon program={row.program.name} size="tab" />
            <Text variant="caption">{row.program.name}</Text>
            {row.age ? (
              <Text variant="caption" tone="dim">
                · {row.age}
              </Text>
            ) : null}
            {row.fromHerdr ? <Tag label="from Herdr" /> : null}
          </View>
          {detail ? (
            <Text style={{ marginTop: 4 }} numberOfLines={2} tone={detailTone} variant="callout">
              {detail}
            </Text>
          ) : null}
        </Pressable>
        {children}
      </View>
    </View>
  );
}

function DoneSwipeRow({
  children,
  enabled,
  followUpEnabled,
  onCheckOff,
  onFollowUp,
}: {
  children: ReactNode;
  enabled: boolean;
  followUpEnabled: boolean;
  onCheckOff(): void;
  onFollowUp(): void;
}) {
  return (
    <ReanimatedSwipeable
      enabled={enabled}
      friction={1}
      overshootRight={false}
      rightThreshold={84}
      renderRightActions={(_progress, _translation, methods) => (
        <DoneActions
          enabled={enabled}
          followUpEnabled={enabled && followUpEnabled}
          methods={methods}
          onCheckOff={onCheckOff}
          onFollowUp={onFollowUp}
        />
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

function DoneActions({
  enabled,
  followUpEnabled,
  methods,
  onCheckOff,
  onFollowUp,
}: {
  enabled: boolean;
  followUpEnabled: boolean;
  methods: SwipeableMethods;
  onCheckOff(): void;
  onFollowUp(): void;
}) {
  return (
    <View className="flex-row">
      <Pressable
        accessibilityRole="button"
        className="min-h-full w-[94px] items-center justify-center gap-1 bg-working px-2"
        disabled={!followUpEnabled}
        onPress={() => {
          methods.close();
          onFollowUp();
        }}
        style={({ pressed }) => ({
          opacity: followUpEnabled && pressed ? 0.8 : followUpEnabled ? 1 : 0.4,
        })}
      >
        <Icon color="solid-fg" name="arrow-up" size={17} />
        <Text variant="caption" tone="solid-fg">
          Follow up
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        className="min-h-full w-[94px] items-center justify-center gap-1 bg-done px-2"
        disabled={!enabled}
        onPress={() => {
          methods.close();
          onCheckOff();
        }}
        style={({ pressed }) => ({ opacity: enabled && pressed ? 0.8 : enabled ? 1 : 0.4 })}
      >
        <Icon color="solid-fg" name="check" size={17} />
        <Text variant="caption" tone="solid-fg">
          Check off
        </Text>
      </Pressable>
    </View>
  );
}

function ListMenu({
  busy,
  onCheckOffAll,
  onClose,
  visible,
}: {
  busy: boolean;
  onCheckOffAll(): void;
  onClose(): void;
  visible: boolean;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 justify-end bg-black/30">
        <Pressable
          accessibilityLabel="Close list options"
          className="absolute inset-0"
          onPress={onClose}
        />
        <View
          className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
          style={{ borderWidth: HAIRLINE }}
        >
          <Text variant="title">Done</Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCheckOffAll}
            style={({ pressed }) => ({ opacity: busy ? 0.4 : pressed ? 0.78 : 1 })}
          >
            <View className="mt-1 min-h-12 justify-center rounded-btn px-3">
              <Text variant="button">Check off all</Text>
            </View>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <View className="mt-2 min-h-11 items-center justify-center rounded-btn">
              <Text variant="button" tone="muted">
                Cancel
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function CheckOffSheet({
  options,
  onClose,
  onChoose,
  visible,
}: {
  options: ReturnType<typeof checkOffSheetOptionsFor>;
  onClose(): void;
  onChoose(choice: CheckOffChoice): void;
  visible: boolean;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 justify-end bg-black/30">
        <Pressable
          accessibilityLabel="Cancel check off"
          className="absolute inset-0"
          onPress={onClose}
        />
        <View
          className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
          style={{ borderWidth: HAIRLINE }}
        >
          <Text variant="title">Check off this task?</Text>
          {options.map((option) => (
            <Pressable
              accessibilityRole="button"
              key={option.id}
              onPress={() => onChoose(option.id)}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
            >
              <View className="mt-1 min-h-12 justify-center rounded-btn px-3">
                <Text
                  variant="button"
                  tone={option.id === "stop" ? "danger" : option.id === "cancel" ? "muted" : "fg"}
                >
                  {option.label}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSmartListKind(value: string | undefined): value is SmartListKind {
  return value === "needs-you" || value === "running" || value === "done";
}

function taskIdentityKey(machineId: string, taskId: string): string {
  return `${machineId}\u0000${taskId}`;
}
