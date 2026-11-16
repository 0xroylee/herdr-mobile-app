import { type Href, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { promptKey, recognizePrompt } from "../../model/prompt.ts";
import { deriveTasks } from "../../model/tasks.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import { createScreenText } from "../../net/screen-text.ts";
import { createTaskActions } from "../../net/task-actions.ts";
import { routes } from "../../routes.ts";
import { coreStore, machinesStore } from "../../store/platform.ts";
import { shortenHomeFolder } from "../../terminal/folder.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { Spinner } from "../../ui/components/Spinner.tsx";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { useComposerController } from "../agent/composer-controller.ts";
import { PromptCard } from "../agent/PromptCard.tsx";
import { useSent } from "../agent/useSent.ts";
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
  answerableTaskScreenRows,
  canFollowUp,
  latestOutputRefreshKey,
  latestOutputRows,
  MatchedTaskLinkController,
  TaskFocusController,
  type TaskMenuAction,
  TaskScreenController,
  type TaskScreenOutput,
  TaskScreenReadGeneration,
  type TaskScreenRuntime,
  taskLinkErrorMessage,
  taskMenuItems,
  taskRowForRoute,
  taskStartedFact,
  taskStateStrip,
  taskTerminalPresentation,
  UNLINKED_TERMINAL_TIMEOUT_MS,
} from "./task-screen-controller.ts";

const emptyTasks: Record<string, never> = {};
const emptyLastSeen = {};

export interface TaskScreenProps {
  taskId: string;
  focusFollowUp?: boolean;
}

export function TaskScreen({ taskId, focusFollowUp = false }: TaskScreenProps) {
  const router = useRouter();
  const manager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const [now, setNow] = useState(() => Date.now());
  const [menuVisible, setMenuVisible] = useState(false);
  const [checkTask, setCheckTask] = useState<TaskIdentity>();
  const [message, setMessage] = useState<string>();
  const [composerError, setComposerError] = useState<string>();
  const [latestOutput, setLatestOutput] = useState<TaskScreenOutput>();
  const [linkController] = useState(() => new MatchedTaskLinkController());
  const [outputGenerationController] = useState(() => new TaskScreenReadGeneration());
  const runtimeRef = useRef<TaskScreenRuntime | undefined>(undefined);
  const [taskController] = useState(
    () =>
      new TaskScreenController(() => {
        if (runtimeRef.current === undefined) throw new Error("Task screen is not ready.");
        return runtimeRef.current;
      }),
  );
  const [focusController] = useState(() => new TaskFocusController());
  const promptAnswerState = useSyncExternalStore(
    taskController.promptAnswer.subscribe,
    taskController.promptAnswer.getSnapshot,
    taskController.promptAnswer.getSnapshot,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
  const row = taskRowForRoute(taskId, taskRows);
  const connection = core?.connection ?? "offline";
  const connected = connection === "connected";
  const control = machine?.role === "control";
  const presentation = connectionPresentation(connection, machine?.name);
  const actions = useMemo(
    () =>
      createTaskActions(
        manager,
        manager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
      ),
    [manager],
  );
  const screenText = useMemo(() => (manager ? createScreenText(manager) : undefined), [manager]);
  const outputRefreshKey = latestOutputRefreshKey(row);
  const outputGeneration = outputGenerationController.next({
    machineId: activeId,
    connected,
    refreshKey: outputRefreshKey,
    terminal: row?.terminal,
    reader: screenText,
  });
  const outputReadRef = useRef<{ generation: number; output: TaskScreenOutput | undefined }>({
    generation: 0,
    output: undefined,
  });
  outputReadRef.current = { generation: outputGeneration, output: latestOutput };
  const screenRows =
    row?.address !== undefined &&
    latestOutput?.machineId === activeId &&
    latestOutput.address === row.address
      ? latestOutput.rows
      : [];
  const answerableRows = answerableTaskScreenRows(
    row,
    activeId,
    outputRefreshKey,
    outputGeneration,
    latestOutput,
  );
  const outputRows = latestOutputRows(screenRows);
  const outputRowCounts = new Map<string, number>();
  const outputItems = outputRows.map((line) => {
    const occurrence = (outputRowCounts.get(line) ?? 0) + 1;
    outputRowCounts.set(line, occurrence);
    return { key: `${line}\u0000${occurrence}`, line };
  });
  const status =
    row?.terminal?.status ??
    (row?.address === undefined ? undefined : core?.lastSeenStatuses?.[row.address]);
  const sent = useSent(status);
  const prompt =
    row?.state === "needs-you" && row.address !== undefined
      ? recognizePrompt(status, answerableRows, row.program.name)
      : undefined;
  const currentPromptKey = prompt === undefined ? undefined : promptKey(prompt);
  const [dismissedPromptKey, setDismissedPromptKey] = useState<string>();

  useEffect(() => {
    setDismissedPromptKey((current) => (current === currentPromptKey ? current : undefined));
  }, [currentPromptKey]);

  useEffect(() => {
    if (!sent.sent) taskController.clearAnsweredPrompt();
  }, [sent.sent, taskController]);

  useEffect(() => {
    if (row?.unlinked !== true) return;
    const remaining = row.createdAt + UNLINKED_TERMINAL_TIMEOUT_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [row?.createdAt, row?.unlinked]);

  useEffect(() => {
    const address = row?.address;
    const terminal = row?.terminal;
    if (!address || !terminal || !screenText || !connected || outputRefreshKey === undefined)
      return;

    let current = true;
    screenText.invalidate(address);
    void screenText
      .read(address, { turn: terminal.turn, state: terminal.status?.state })
      .then((rows) => {
        if (current && activeId !== null && outputRefreshKey !== undefined) {
          setLatestOutput({
            machineId: activeId,
            address,
            refreshKey: outputRefreshKey,
            generation: outputGeneration,
            rows,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [
    activeId,
    connected,
    outputGeneration,
    outputRefreshKey,
    row?.address,
    row?.terminal,
    screenText,
  ]);

  useEffect(() => {
    const request = linkController.claim(row, machine?.role, connection);
    if (request === undefined) return;

    let current = true;
    void actions.link(request).catch((error: unknown) => {
      const errorMessage = taskLinkErrorMessage(error);
      if (current && errorMessage !== undefined) setMessage(errorMessage);
    });
    return () => {
      current = false;
    };
  }, [actions, connection, linkController, machine?.role, row]);

  const taskTerminal = taskTerminalPresentation(row, now);
  const canSendFollowUp = canFollowUp(row, machine?.role, connection);
  const menuItems = taskMenuItems(row, machine?.role, connection, now);
  const checkTaskRow =
    checkTask !== undefined && checkTask.machineId === activeId
      ? taskRowForRoute(checkTask.taskId, taskRows)
      : undefined;
  const checkOptions =
    checkTask !== undefined && checkTaskRow !== undefined
      ? checkOffSheetOptionsFor(
          checkTaskRow,
          checkTask.machineId,
          activeId,
          machine?.role,
          connection,
        )
      : [];

  const handleFocusConsumed = useCallback(() => {
    router.setParams({ focus: undefined });
  }, [router]);

  const taskIdentity =
    row === undefined || activeId === null ? undefined : { machineId: activeId, taskId: row.id };

  function currentTaskSnapshot(identity: TaskIdentity) {
    const machineState = machinesStore.getState();
    const activeMachineId = machineState.activeId;
    const currentCore =
      activeMachineId === null ? undefined : coreStore.getState().machines[activeMachineId];
    const currentTasks = deriveTasks(
      currentCore?.tasks?.tasks ?? emptyTasks,
      currentCore?.terminals ?? {},
      currentCore?.layout,
      currentCore?.lastSeenStatuses ?? emptyLastSeen,
      Date.now(),
    );
    const currentRow = taskRowForRoute(identity.taskId, currentTasks);
    const outputRead = outputReadRef.current;
    const currentPromptRows = answerableTaskScreenRows(
      currentRow,
      activeMachineId,
      latestOutputRefreshKey(currentRow),
      outputRead.generation,
      outputRead.output,
    );
    const currentStatus =
      currentRow?.terminal?.status ??
      (currentRow?.address === undefined
        ? undefined
        : currentCore?.lastSeenStatuses?.[currentRow.address]);

    return {
      activeMachineId,
      role: activeMachineId === null ? undefined : machineState.machines[activeMachineId]?.role,
      connection: currentCore?.connection,
      row: currentRow,
      prompt:
        currentRow?.state === "needs-you" && currentRow.address !== undefined
          ? recognizePrompt(currentStatus, currentPromptRows, currentRow.program.name)
          : undefined,
      screenGeneration: outputRead.generation,
    };
  }

  function currentCheckOff(identity: TaskIdentity): CheckOffCurrent {
    const machineState = machinesStore.getState();
    const activeMachineId = machineState.activeId;
    const currentCore =
      activeMachineId === null ? undefined : coreStore.getState().machines[activeMachineId];
    const currentRow =
      activeMachineId === null || currentCore === undefined
        ? undefined
        : taskRowForRoute(
            identity.taskId,
            deriveTasks(
              currentCore.tasks?.tasks ?? emptyTasks,
              currentCore.terminals,
              currentCore.layout,
              currentCore.lastSeenStatuses ?? emptyLastSeen,
              Date.now(),
            ),
          );

    return {
      activeMachineId,
      role: activeMachineId === null ? undefined : machineState.machines[activeMachineId]?.role,
      connection: currentCore?.connection,
      row: currentRow,
    };
  }

  async function selectMenuAction(action: TaskMenuAction) {
    setMenuVisible(false);
    setMessage(undefined);
    if (taskIdentity === undefined) return;
    try {
      const result = await taskController.selectMenuAction(taskIdentity, action.id);
      if (result.kind === "open-terminal") {
        router.push(routes.agent(result.address) as Href);
      } else if (result.kind === "check-off") {
        if (result.result === "ask") setCheckTask(taskIdentity);
        else setCheckTask(undefined);
      } else if (result.kind === "refused" && action.id === "interrupt") {
        setMessage("Couldn't interrupt this agent.");
      }
    } catch (error) {
      const fallback =
        action.id === "copy-address"
          ? "Couldn't copy the address."
          : action.id === "stop-agent"
            ? "Couldn't stop this agent."
            : "Couldn't complete this task action.";
      setMessage(errorText(error, fallback));
    }
  }

  async function sendComposer(text: string): Promise<boolean> {
    if (taskIdentity === undefined) return false;
    setComposerError(undefined);
    try {
      const result = await taskController.submitComposer(taskIdentity, text, {
        optionsOffered,
        promptKey: currentPromptKey,
        screenGeneration: outputGeneration,
      });
      if (result.kind === "refused") {
        if (result.notice !== undefined) setComposerError(result.notice);
        return false;
      }
      return true;
    } catch (error) {
      setComposerError(errorText(error, "Couldn't send the follow-up."));
      return false;
    }
  }

  async function answerPrompt(keys: readonly string[]) {
    if (taskIdentity === undefined || currentPromptKey === undefined) return;
    const result = await taskController.answerPrompt(taskIdentity, keys, {
      promptKey: currentPromptKey,
      screenGeneration: outputGeneration,
    });
    if (result.kind === "refused" && result.notice !== undefined) {
      setMessage(result.notice);
    }
  }

  async function checkOff(identity: TaskIdentity, choice?: CheckOffChoice) {
    setMessage(undefined);
    try {
      const result = await taskController.checkOff(identity, choice);
      if (result === "ask") setCheckTask(identity);
      else setCheckTask(undefined);
    } catch (error) {
      setCheckTask(undefined);
      setMessage(errorText(error, "Couldn't check off the task."));
    }
  }

  async function copyAddress(address: string) {
    try {
      await taskController.copyAddress(address);
      setMessage(undefined);
    } catch (error) {
      setMessage(errorText(error, "Couldn't copy the address."));
    }
  }

  runtimeRef.current = {
    current: currentTaskSnapshot,
    actions,
    runCheckOff: (identity, choice) =>
      runCheckOffAction(identity, choice, {
        current: () => currentCheckOff(identity),
        actions,
      }),
    markSent: sent.markSent,
  };

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(routes.home as Href);
  }

  const outputFolder = row?.record?.folder ?? row?.terminal?.cwd ?? row?.project.folder;
  const stateStrip = row === undefined ? undefined : taskStateStrip(row.state, row.age);
  const optionsOffered =
    connected &&
    control &&
    currentPromptKey !== undefined &&
    currentPromptKey !== dismissedPromptKey;

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-canvas px-3.5 pt-safe pb-safe"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="min-h-11 flex-row items-center justify-between">
        <IconButton accessibilityLabel="Back" icon="chevron-left" onPress={goBack} size="back" />
        <View className="min-w-0 flex-1 px-2">
          <Text numberOfLines={1} variant="title">
            {row?.project.name ?? "Task"}
          </Text>
        </View>
        {menuItems.length > 0 ? (
          <IconButton
            accessibilityLabel="More task options"
            icon="ellipsis"
            onPress={() => setMenuVisible(true)}
          />
        ) : (
          <View className="h-11 w-11" />
        )}
      </View>

      <ConnectionBanner presentation={presentation} />

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="gap-3 pb-3 pt-1.5"
        showsVerticalScrollIndicator={false}
        style={presentation.dimmed ? { opacity: 0.6 } : undefined}
      >
        {row === undefined ? (
          <View className="min-h-[200px] items-center justify-center">
            <Text variant="callout" tone="dim">
              This task isn’t available.
            </Text>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 21, lineHeight: 27, letterSpacing: -0.2 }} variant="pairTitle">
              {row.record?.text ?? row.title}
            </Text>

            {stateStrip ? (
              <View className="flex-row items-center justify-between px-1.5">
                <View className="flex-row items-center gap-2">
                  <TaskStateMark mark={stateStrip.mark} />
                  <Text variant="subhead" tone={stateStrip.tone}>
                    {stateStrip.label}
                  </Text>
                </View>
                <View className="flex-row items-center gap-1.5">
                  <ProgramIcon program={row.program.name} size="pane" />
                  <Text variant="subhead" tone="muted">
                    {row.program.name}
                  </Text>
                </View>
              </View>
            ) : null}

            {row.state === "stopped" && row.stoppedText && taskTerminal !== "missing" ? (
              <Text variant="callout" tone="danger">
                {row.stoppedText}
              </Text>
            ) : null}

            {prompt ? (
              <PromptCard
                age={row.age}
                disabled={!connected}
                onChoice={(keys) => void answerPrompt(keys)}
                onDismiss={() => setDismissedPromptKey(currentPromptKey)}
                optionsOffered={optionsOffered}
                pending={promptAnswerState.answering}
                program={row.program.name}
                prompt={prompt}
                readOnly={!control}
                sent={
                  sent.sent &&
                  currentPromptKey !== undefined &&
                  taskController.isPromptAnswered(currentPromptKey)
                }
              />
            ) : row.state === "needs-you" ? (
              <View className="rounded-card border-prompt-border bg-prompt-bg px-3.5 py-3">
                <Text variant="callout" tone="muted">
                  Open terminal to answer
                </Text>
              </View>
            ) : null}

            <View
              className="overflow-hidden rounded-card border-border bg-term-bg"
              style={{ borderWidth: HAIRLINE }}
            >
              <View className="min-h-8 flex-row items-center gap-2 border-b-border px-3">
                <ProgramIcon program={row.program.name} size="pane" />
                <Text variant="captionMedium">Latest output</Text>
                <View className="min-w-0 flex-1" />
                {outputFolder ? (
                  <Text numberOfLines={1} variant="caption" tone="dim">
                    {shortenHomeFolder(outputFolder)}
                  </Text>
                ) : null}
              </View>
              <View className="min-h-[72px] justify-center gap-0.5 px-3 py-2.5">
                {outputItems.map(({ key, line }) => (
                  <Text key={key} numberOfLines={1} variant="terminal">
                    {line}
                  </Text>
                ))}
                {taskTerminal === "missing" ? (
                  <Text variant="callout" tone="muted">
                    The terminal is gone.
                  </Text>
                ) : outputItems.length > 0 ? null : taskTerminal === "starting" ? (
                  <View className="flex-row items-center gap-2">
                    <Spinner size={14} />
                    <Text variant="callout" tone="muted">
                      Starting in Herdr…
                    </Text>
                  </View>
                ) : taskTerminal === "not-found" ? (
                  <Text variant="callout" tone="muted">
                    Couldn’t find this task’s terminal.
                  </Text>
                ) : (
                  <Text variant="callout" tone="dim">
                    No output yet.
                  </Text>
                )}
              </View>
              {row.terminal !== undefined && row.address !== undefined ? (
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 flex-row items-center justify-center gap-2 border-t-border"
                  disabled={!connected}
                  onPress={() => router.push(routes.agent(row.address as string) as Href)}
                  style={{ borderTopWidth: HAIRLINE, opacity: connected ? 1 : 0.4 }}
                >
                  <Icon color="muted" name="terminal" size={15} />
                  <Text variant="button" tone="muted">
                    Open terminal
                  </Text>
                  <Icon color="dim" name="chevron-right" size={15} />
                </Pressable>
              ) : null}
            </View>

            <View
              className="mt-0.5 overflow-hidden rounded-card border-border bg-surface"
              style={{ borderWidth: HAIRLINE }}
            >
              <FactRow label="Project" value={row.project.name} />
              <View className="bg-border" style={{ height: HAIRLINE }} />
              <FactRow label="Started" value={taskStartedFact(row, now)} />
              {outputFolder ? (
                <>
                  <View className="bg-border" style={{ height: HAIRLINE }} />
                  <FactRow label="Folder" value={shortenHomeFolder(outputFolder)} mono />
                </>
              ) : null}
              {row.address ? (
                <>
                  <View className="bg-border" style={{ height: HAIRLINE }} />
                  <FactRow
                    label="Terminal"
                    mono
                    onCopy={connected ? () => void copyAddress(row.address as string) : undefined}
                    value={row.address}
                  />
                </>
              ) : null}
            </View>
          </>
        )}

        {taskTerminal === "not-found" && control && connected ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-11 items-center justify-center rounded-btn border-border bg-surface px-3"
            onPress={() => {
              if (taskIdentity !== undefined) void checkOff(taskIdentity);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
          >
            <Text variant="button">Check off</Text>
          </Pressable>
        ) : null}

        {message ? (
          <Text accessibilityRole="alert" variant="caption" tone="danger">
            {message}
          </Text>
        ) : null}
      </ScrollView>

      <TaskComposer
        disabled={!canSendFollowUp}
        error={composerError}
        focusController={focusController}
        focusRequested={focusFollowUp}
        key={taskId}
        taskId={taskId}
        onFocusHandled={handleFocusConsumed}
        onSend={sendComposer}
        program={row?.program.name ?? "agent"}
        sent={sent.sent}
      />

      <TaskMenu
        actions={menuItems}
        onClose={() => setMenuVisible(false)}
        onSelect={(action) => void selectMenuAction(action)}
        title={row?.title ?? "Task actions"}
        visible={menuVisible}
      />
      <CheckOffSheet
        onChoose={(choice) => {
          if (checkTask !== undefined) void checkOff(checkTask, choice);
        }}
        onClose={() => setCheckTask(undefined)}
        options={checkOptions}
        visible={checkTask !== undefined}
      />
    </KeyboardAvoidingView>
  );
}

function TaskStateMark({ mark }: { mark: ReturnType<typeof taskStateStrip>["mark"] }) {
  if (mark === "stopped") {
    return (
      <View className="h-4 w-4 items-center justify-center rounded-full border border-danger">
        <Icon color="danger" name="x" size={10} strokeWidth={2.2} />
      </View>
    );
  }
  if (mark === "checked") return <Icon color="done" name="check" size={15} strokeWidth={2.2} />;
  return <StatusMark state={mark} />;
}

function FactRow({
  label,
  value,
  mono = false,
  onCopy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onCopy?: () => void;
}) {
  return (
    <View className="min-h-11 flex-row items-center gap-3 px-3.5 py-2">
      <Text variant="caption" tone="dim">
        {label}
      </Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
        <Text numberOfLines={2} selectable variant={mono ? "mono" : "body"}>
          {value}
        </Text>
        {onCopy ? (
          <Pressable
            accessibilityLabel={`Copy ${label.toLowerCase()}`}
            accessibilityRole="button"
            className="min-h-9 min-w-9 items-center justify-center"
            onPress={onCopy}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Icon color="muted" name="copy" size={15} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function TaskComposer({
  program,
  sent,
  disabled,
  error,
  focusController,
  focusRequested,
  taskId,
  onFocusHandled,
  onSend,
}: {
  program: string;
  sent: boolean;
  disabled: boolean;
  error: string | undefined;
  focusController: TaskFocusController;
  focusRequested: boolean;
  taskId: string;
  onFocusHandled(): void;
  onSend(text: string): Promise<boolean>;
}) {
  const { value, pending: sending, setValue, submit } = useComposerController();
  const [focusMounted, setFocusMounted] = useState(false);
  const dim = useCSSVariable("--color-dim");
  const solidForeground = useCSSVariable("--color-solid-fg");
  const focusReady = (focusRequested && !disabled) || focusMounted;

  return (
    <View className="pb-1">
      {sent ? (
        <View className="mb-1.5 px-1">
          <Text variant="subhead" tone="muted">
            Sent · waiting for {program}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View className="mb-1.5 px-1">
          <Text variant="subhead" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}
      <View
        className="flex-row items-center rounded-field border-border bg-surface p-[9px] pl-[15px]"
        style={{ borderWidth: HAIRLINE }}
      >
        <TextInput
          accessibilityLabel="Follow up"
          autoFocus={focusRequested && !disabled}
          className="min-h-8 min-w-0 flex-1 p-0 font-sans text-[15px] leading-[21px] text-fg"
          editable={!disabled && !sending}
          onChangeText={setValue}
          onFocus={() => {
            if (focusRequested) {
              focusController.consume(taskId, () => {
                setFocusMounted(true);
                onFocusHandled();
              });
            }
          }}
          onSubmitEditing={() => void submit(disabled, onSend)}
          placeholder="Follow up…"
          placeholderTextColor={typeof dim === "string" ? dim : undefined}
          key={focusReady ? "follow-up-focus" : "follow-up"}
          returnKeyType="send"
          value={value}
        />
        <Pressable
          accessibilityLabel="Send follow-up"
          accessibilityRole="button"
          className="min-h-11 min-w-11 items-center justify-center"
          disabled={disabled || sending || value.trim().length === 0}
          onPress={() => void submit(disabled, onSend)}
          style={({ pressed }) => ({
            opacity: disabled || sending || value.trim().length === 0 ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          <View className="h-8 w-8 items-center justify-center rounded-full bg-solid">
            {sending ? (
              <ActivityIndicator
                color={typeof solidForeground === "string" ? solidForeground : undefined}
                size="small"
              />
            ) : (
              <Icon color="solid-fg" name="arrow-up" size={17} strokeWidth={2.2} />
            )}
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function TaskMenu({
  actions,
  visible,
  title,
  onClose,
  onSelect,
}: {
  actions: TaskMenuAction[];
  visible: boolean;
  title: string;
  onClose(): void;
  onSelect(action: TaskMenuAction): void;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 justify-end bg-black/30">
        <Pressable
          accessibilityLabel="Close task options"
          className="absolute inset-0"
          onPress={onClose}
        />
        <View
          className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
          style={{ borderWidth: HAIRLINE }}
        >
          <Text numberOfLines={2} variant="title">
            {title}
          </Text>
          {actions.map((action) => (
            <Pressable accessibilityRole="button" key={action.id} onPress={() => onSelect(action)}>
              {({ pressed }) => (
                <View
                  className={`mt-1 min-h-12 justify-center rounded-btn px-3 ${pressed ? "bg-raised" : "bg-surface"}`}
                >
                  <Text variant="button" tone={action.destructive ? "danger" : "fg"}>
                    {action.label}
                  </Text>
                </View>
              )}
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" onPress={onClose}>
            <View className="mt-2 min-h-11 items-center justify-center rounded-btn bg-surface">
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
  visible,
  onClose,
  onChoose,
}: {
  options: ReturnType<typeof checkOffSheetOptionsFor>;
  visible: boolean;
  onClose(): void;
  onChoose(choice: CheckOffChoice): void;
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
          {options
            .filter((option) => option.id !== "cancel")
            .map((option) => (
              <Pressable
                accessibilityRole="button"
                key={option.id}
                onPress={() => onChoose(option.id)}
              >
                {({ pressed }) => (
                  <View
                    className={`mt-1 min-h-12 justify-center rounded-btn px-3 ${pressed ? "bg-raised" : "bg-surface"}`}
                  >
                    <Text variant="button" tone={option.id === "stop" ? "danger" : "fg"}>
                      {option.label}
                    </Text>
                  </View>
                )}
              </Pressable>
            ))}
          <Pressable accessibilityRole="button" onPress={() => onChoose("cancel")}>
            <View className="mt-2 min-h-11 items-center justify-center rounded-btn bg-surface">
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

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
