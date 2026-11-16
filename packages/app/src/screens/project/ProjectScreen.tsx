import type { Layout, TaskRecord } from "@herdr-mobile/protocol";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { summarize } from "../../model/summary.ts";
import { deriveTasks, type TaskProject, type TaskRow as TaskRowModel } from "../../model/tasks.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import { createScreenText } from "../../net/screen-text.ts";
import { createTaskActions } from "../../net/task-actions.ts";
import { routes } from "../../routes.ts";
import { coreStore, machinesStore, settingsStore } from "../../store/platform.ts";
import { shortenHomeFolder } from "../../terminal/folder.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { ConnectionBanner } from "../home/ConnectionBanner.tsx";
import { connectionPresentation } from "../home/connectionPresentation.ts";
import { newTaskLabelTone } from "../home/home-view.ts";
import { AccessoryBar } from "./AccessoryBar.tsx";
import { CheckedBar } from "./CheckedBar.tsx";
import {
  type CheckOffChoice,
  type CheckOffCurrent,
  checkOffSheetOptionsFor,
  resolveTaskRow,
  runCheckOff as runCheckOffAction,
  type TaskIdentity,
} from "./check-off.ts";
import {
  getNewTaskController,
  type NewTaskContext,
  NewTaskController,
  newTaskControllerKey,
} from "./new-task-controller.ts";
import { bindNewTaskController, createNewTaskPort } from "./new-task-port.ts";
import {
  cacheTaskSummaryRead,
  deriveProjectView,
  openProjectTaskDetails,
  type ProjectRowAction,
  projectRowActions,
  projectTaskRows,
  shouldReadTaskSummary,
  type TaskSummaryRow,
  taskSummary,
  taskSummaryKey,
} from "./project-view.ts";
import { TaskComposer } from "./TaskComposer.tsx";
import { TaskRow } from "./TaskRow.tsx";
import { projectTaskId } from "./viewState.ts";

const emptyTasks: Record<string, never> = {};
const emptyLastSeen = {};
const emptyRecentFolders: string[] = [];

export function ProjectScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; focus?: string | string[] }>();
  const router = useRouter();
  const connectionManager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const recentFolders = useStore(settingsStore, (state) =>
    activeId === null ? emptyRecentFolders : (state.recentFolders[activeId] ?? emptyRecentFolders),
  );
  const lastRun = useStore(settingsStore, (state) =>
    activeId === null ? undefined : state.lastRun[activeId],
  );
  const projectId = firstParam(params.id) ?? "other";
  const taskProjectId = projectTaskId(projectId, core?.layout);
  const [focusRequest, setFocusRequest] = useState(() =>
    firstParam(params.focus) === "composer" ? 1 : 0,
  );
  const [showChecked, setShowChecked] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskIdentity>();
  const [checkTask, setCheckTask] = useState<TaskIdentity>();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<string>();
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const requestedSummaries = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const calls = useMemo(
    () =>
      connectionManager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
    [connectionManager],
  );
  const taskPort = useMemo(
    () =>
      createNewTaskPort(calls, {
        rememberRun: (machineId, run) => settingsStore.getState().setLastRun(machineId, run),
        rememberFolder: (machineId, folder) =>
          settingsStore.getState().pushRecentFolder(machineId, folder),
      }),
    [calls],
  );
  const taskContext = useMemo<NewTaskContext>(
    () => ({
      machineId: activeId ?? undefined,
      role: machine?.role,
      connected: core?.connection === "connected",
      layout: core?.layout,
      terminals: core?.terminals ?? {},
      recentFolders,
      lastRun,
    }),
    [
      activeId,
      core?.connection,
      core?.layout,
      core?.terminals,
      lastRun,
      machine?.role,
      recentFolders,
    ],
  );
  const newTaskKey = newTaskControllerKey(activeId ?? "unpaired", projectId);
  const newTaskController = useMemo(
    () =>
      getNewTaskController(
        newTaskKey,
        () =>
          new NewTaskController(taskPort, taskContext, {
            project: { kind: "existing", id: projectId },
          }),
      ),
    [newTaskKey, projectId, taskContext, taskPort],
  );
  const newTaskState = useSyncExternalStore(
    newTaskController.subscribe,
    newTaskController.getSnapshot,
    newTaskController.getSnapshot,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bindNewTaskController(newTaskController, connectionManager, taskContext, {
      rememberRun: (machineId, run) => settingsStore.getState().setLastRun(machineId, run),
      rememberFolder: (machineId, folder) =>
        settingsStore.getState().pushRecentFolder(machineId, folder),
    });
  }, [connectionManager, newTaskController, taskContext]);

  useEffect(() => {
    if (
      machine?.role === "control" &&
      core?.connection === "connected" &&
      !newTaskController.state.catalog &&
      !newTaskController.state.catalogError
    ) {
      void newTaskController.load();
    }
  }, [core?.connection, machine?.role, newTaskController]);

  useEffect(() => {
    newTaskController.reconcileTasks(
      core?.tasks?.tasks ?? emptyTasks,
      newTaskState.optimisticRecords,
    );
  }, [core?.tasks, newTaskController, newTaskState.optimisticRecords]);

  const taskRecords = useMemo(() => {
    const records: Record<string, TaskRecord> = { ...(core?.tasks?.tasks ?? {}) };
    for (const optimistic of newTaskState.optimisticRecords) {
      if (!records[optimistic.id]) records[optimistic.id] = optimistic;
    }
    return records;
  }, [core?.tasks, newTaskState.optimisticRecords]);

  const taskRows = useMemo(
    () =>
      deriveTasks(
        taskRecords,
        core?.terminals ?? {},
        core?.layout,
        core?.lastSeenStatuses ?? emptyLastSeen,
        now,
      ),
    [core?.lastSeenStatuses, core?.layout, core?.terminals, now, taskRecords],
  );
  const project = useMemo(
    () => findProject(taskProjectId, core?.layout, taskRows.rows),
    [core?.layout, taskProjectId, taskRows.rows],
  );
  const connection = core?.connection ?? "offline";
  const connectionState = connectionPresentation(connection, machine?.name);
  const rows = useMemo(
    () => projectTaskRows(taskProjectId, taskRows.rows),
    [taskProjectId, taskRows.rows],
  );
  const view = useMemo(
    () => deriveProjectView({ project, rows, role: machine?.role, connection, showChecked }),
    [connection, machine?.role, project, rows, showChecked],
  );
  const actions = useMemo(
    () =>
      createTaskActions(
        connectionManager,
        connectionManager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
      ),
    [connectionManager],
  );
  const screenText = useMemo(
    () => (connectionManager ? createScreenText(connectionManager) : undefined),
    [connectionManager],
  );

  const selectedTaskRow = currentRenderTask(selectedTask, activeId, taskRows.rows);
  const checkTaskRow = currentRenderTask(checkTask, activeId, taskRows.rows);

  const summaryRow = useCallback(
    (row: TaskRowModel): TaskSummaryRow => ({
      ...row,
      lastSeenStatus: row.address === undefined ? undefined : core?.lastSeenStatuses?.[row.address],
    }),
    [core?.lastSeenStatuses],
  );

  useEffect(() => {
    if (screenText === undefined || connection !== "connected") return;
    for (const sourceRow of view.rows) {
      const row = summaryRow(sourceRow);
      if (!shouldReadTaskSummary(row, summaries) || row.address === undefined) continue;
      const address = row.address;
      const key = taskSummaryKey(row);
      if (requestedSummaries.current.has(key)) continue;
      requestedSummaries.current.add(key);
      void screenText
        .read(address, { turn: row.terminal?.turn, state: row.terminal?.status?.state })
        .then((screenRows) => {
          const terminal = coreStore.getState().machines[activeId ?? ""]?.terminals[address];
          setSummaries((previous) =>
            cacheTaskSummaryRead(
              previous,
              row,
              terminal,
              summarize(row.program.iconKey, undefined, screenRows),
            ),
          );
        })
        .catch(() => {
          setSummaries((previous) => ({ ...previous, [key]: "No summary yet." }));
        });
    }
  }, [activeId, connection, screenText, summaryRow, summaries, view.rows]);

  const openTerminal = (address: string) => router.push(routes.agent(address) as Href);
  const goHome = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.home as Href);
  };

  function identityFor(row: TaskRowModel): TaskIdentity | undefined {
    return activeId === null ? undefined : { machineId: activeId, taskId: row.id };
  }

  function latestTaskRow(identity: TaskIdentity): TaskRowModel | undefined {
    const currentMachineId = machinesStore.getState().activeId;
    if (currentMachineId !== identity.machineId) return undefined;
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
    const row =
      activeMachineId === null || currentCore === undefined
        ? undefined
        : deriveTasks(
            currentCore.tasks?.tasks ?? emptyTasks,
            currentCore.terminals,
            currentCore.layout,
            currentCore.lastSeenStatuses ?? emptyLastSeen,
            Date.now(),
          ).taskFor(identity.taskId);

    return {
      activeMachineId,
      role: activeMachineId === null ? undefined : machineState.machines[activeMachineId]?.role,
      connection: currentCore?.connection,
      row,
    };
  }

  async function runCheckOff(identity: TaskIdentity, choice?: CheckOffChoice) {
    setMessage(undefined);
    try {
      const result = await runCheckOffAction(identity, choice, {
        current: () => currentCheckOff(identity),
        actions,
      });
      if (result === "ask") {
        setCheckTask(identity);
        return;
      }
      setCheckTask(undefined);
      setSelectedTask(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't check off the task.");
    }
  }

  async function clearChecked() {
    if (!view.canClear || isClearing) return;
    setIsClearing(true);
    setMessage(undefined);
    try {
      await actions.clear({ spaceId: project.id });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't clear checked-off tasks.");
    } finally {
      setIsClearing(false);
    }
  }

  async function selectTaskAction(identity: TaskIdentity, action: ProjectRowAction) {
    setSelectedTask(undefined);
    if (action.id === "check-off") {
      await runCheckOff(identity);
      return;
    }
    const row = latestTaskRow(identity);
    if (row === undefined) return;
    const machineState = machinesStore.getState();
    const currentMachineId = machineState.activeId;
    const currentRole =
      currentMachineId === null ? undefined : machineState.machines[currentMachineId]?.role;
    const currentConnection =
      currentMachineId === null
        ? undefined
        : coreStore.getState().machines[currentMachineId]?.connection;
    if (currentConnection !== "connected") return;
    if (
      !projectRowActions(row, currentRole, currentConnection).some(({ id }) => id === action.id)
    ) {
      return;
    }
    if (action.id === "open-terminal" && row.address !== undefined && row.terminal !== undefined) {
      openTerminal(row.address);
    }
    if (action.id === "copy-address" && row.address !== undefined) {
      try {
        await actions.copy(row.address);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Couldn't copy the address.");
      }
    }
  }

  const selectedActions = selectedTaskRow
    ? projectRowActions(selectedTaskRow, machine?.role, connection)
    : [];
  const checkOptions =
    checkTask && checkTaskRow
      ? checkOffSheetOptionsFor(
          checkTaskRow,
          checkTask.machineId,
          activeId,
          machine?.role,
          connection,
        )
      : [];

  return (
    <View className="flex-1 bg-canvas px-3.5 pt-safe">
      <View className="min-h-11 flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center gap-1"
          onPress={goHome}
        >
          <Icon color="muted" name="chevron-left" size={22} />
          <Text variant="button" tone="muted">
            Projects
          </Text>
        </Pressable>
        <IconButton
          accessibilityLabel="More project options"
          icon="ellipsis"
          onPress={() => setProjectMenuOpen(true)}
        />
      </View>

      <ConnectionBanner presentation={connectionState} />

      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="min-h-0 flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="pb-3 pt-2">
          <Text variant="pairTitle">{project.name}</Text>
          {project.folder ? (
            <Text variant="mono" tone="dim">
              {shortenHomeFolder(project.folder)}
            </Text>
          ) : null}
        </View>

        <CheckedBar
          canClear={view.canClear && !isClearing}
          count={view.checkedCount}
          onClear={() => void clearChecked()}
          onToggle={() => setShowChecked((shown) => !shown)}
          showClear={view.showClear}
          shown={showChecked}
        />

        <View style={connectionState.dimmed ? { opacity: 0.6 } : undefined}>
          {view.rows.map((row) => (
            <TaskRow
              canCheckOff={view.canCheckOff}
              key={row.id}
              onCheckOff={() => {
                const identity = identityFor(row);
                if (identity !== undefined) void runCheckOff(identity);
              }}
              onLongPress={() => {
                if (
                  view.actionsEnabled &&
                  projectRowActions(row, machine?.role, connection).length > 0
                ) {
                  const identity = identityFor(row);
                  if (identity !== undefined) setSelectedTask(identity);
                }
              }}
              onPress={() => router.push(routes.task(row.id) as Href)}
              row={row}
              summary={taskSummary(summaryRow(row), summaries)}
            />
          ))}
        </View>
        {message ? (
          <View className="py-2">
            <Text accessibilityRole="alert" variant="caption" tone="blocked">
              {message}
            </Text>
          </View>
        ) : null}
        {view.showComposer ? (
          <>
            <TaskComposer
              controller={newTaskController}
              disabled={!view.actionsEnabled}
              focusRequest={focusRequest}
              onGo={() => void newTaskController.go()}
              onRefresh={() => void newTaskController.load()}
              onRetry={() => void newTaskController.go()}
              state={newTaskState}
            />
            <AccessoryBar
              catalog={newTaskState.catalog}
              disabled={
                !view.actionsEnabled ||
                newTaskState.status === "starting" ||
                newTaskState.loadingCatalog
              }
              folder={newTaskState.draft.folder}
              folderError={newTaskState.fieldErrors?.folder}
              folderPickerRequest={newTaskState.folderPickerRequest}
              home={newTaskState.catalog?.home}
              onDetails={() => openProjectTaskDetails(router, projectId, newTaskState.draft)}
              onFolder={(folder) => newTaskController.setFolder(folder)}
              onRun={(run) => newTaskController.setRun(run)}
              options={newTaskState.options}
              project={newTaskState.draft.project}
              run={newTaskState.draft.run}
            />
          </>
        ) : null}
      </ScrollView>

      {view.showComposer ? (
        <View
          className="flex-row items-center border-t-border py-2"
          style={{ borderTopWidth: HAIRLINE }}
        >
          <Pressable
            accessibilityRole="button"
            className="min-h-11 flex-row items-center gap-2"
            onPress={() => setFocusRequest((request) => request + 1)}
          >
            <View className="h-8 w-8 items-center justify-center rounded-full bg-solid">
              <Icon color="solid-fg" name="plus" size={18} />
            </View>
            <Text tone={newTaskLabelTone} variant="buttonLarge">
              New task
            </Text>
          </Pressable>
        </View>
      ) : null}

      <ActionSheet
        actions={selectedActions}
        onClose={() => setSelectedTask(undefined)}
        onSelect={(action) => {
          if (selectedTask !== undefined) void selectTaskAction(selectedTask, action);
        }}
        title={selectedTaskRow?.title ?? "Task actions"}
        visible={selectedTask !== undefined}
      />
      <ActionSheet
        actions={[{ id: "terminals", label: "Terminals" }]}
        onClose={() => setProjectMenuOpen(false)}
        onSelect={() => {
          setProjectMenuOpen(false);
          router.push(routes.projectTerminals(projectId) as Href);
        }}
        title={project.name}
        visible={projectMenuOpen}
      />
      <CheckOffSheet
        onChoose={(choice) => {
          if (checkTask !== undefined) void runCheckOff(checkTask, choice);
        }}
        onClose={() => setCheckTask(undefined)}
        options={checkOptions}
        visible={checkTask !== undefined}
      />
    </View>
  );
}

function ActionSheet<T extends { id: string; label: string }>({
  actions: items,
  onClose,
  onSelect,
  title,
  visible,
}: {
  actions: T[];
  onClose(): void;
  onSelect(action: T): void;
  title: string;
  visible: boolean;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 justify-end bg-black/30">
        <Pressable
          accessibilityLabel="Close actions"
          className="absolute inset-0"
          onPress={onClose}
        />
        <View
          className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
          style={{ borderWidth: HAIRLINE }}
        >
          <Text numberOfLines={1} variant="title">
            {title}
          </Text>
          {items.map((action) => (
            <Pressable accessibilityRole="button" key={action.id} onPress={() => onSelect(action)}>
              {({ pressed }) => (
                <View
                  className={`mt-1 min-h-12 justify-center rounded-btn px-3 ${pressed ? "bg-raised" : "bg-surface"}`}
                >
                  <Text variant="button">{action.label}</Text>
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

function findProject(
  id: string,
  layout: Layout | undefined,
  rows: readonly TaskRowModel[],
): TaskProject {
  const space = layout?.spaces.find((candidate) => candidate.id === id);
  if (space) {
    const folder = space.folder ?? undefined;
    const name = space.name.trim() || folder?.split(/[\\/]/u).filter(Boolean).at(-1) || "Other";
    return { id, name, folder };
  }
  return (
    rows.find((row) => row.project.id === id)?.project ?? {
      id,
      name: id === "other" ? "Other" : id,
      folder: undefined,
    }
  );
}

function currentRenderTask(
  identity: TaskIdentity | undefined,
  activeMachineId: string | null,
  rows: readonly TaskRowModel[],
): TaskRowModel | undefined {
  if (identity === undefined || identity.machineId !== activeMachineId) return undefined;
  return resolveTaskRow(identity.taskId, rows);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
