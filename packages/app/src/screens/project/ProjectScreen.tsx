import type { Layout } from "@herdr-mobile/protocol";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { summarize } from "../../model/summary.ts";
import { deriveTasks, type TaskProject, type TaskRow as TaskRowModel } from "../../model/tasks.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import { createScreenText } from "../../net/screen-text.ts";
import { createTaskActions } from "../../net/task-actions.ts";
import { routes } from "../../routes.ts";
import { coreStore, machinesStore } from "../../store/platform.ts";
import { shortenHomeFolder } from "../../terminal/folder.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { ConnectionBanner } from "../home/ConnectionBanner.tsx";
import { connectionPresentation } from "../home/connectionPresentation.ts";
import { CheckedBar } from "./CheckedBar.tsx";
import {
  applyCheckOff,
  type CheckOffChoice,
  checkOffSheetOptions,
  needsCheckOffSheet,
} from "./check-off.ts";
import { deriveProjectView, type ProjectRowAction, projectRowActions } from "./project-view.ts";
import { TaskRow } from "./TaskRow.tsx";

const emptyTasks: Record<string, never> = {};

export function ProjectScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const router = useRouter();
  const connectionManager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const projectId = firstParam(params.id) ?? "other";
  const [showChecked, setShowChecked] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskRowModel>();
  const [checkTask, setCheckTask] = useState<TaskRowModel>();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<string>();
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const requestedSummaries = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const taskRows = useMemo(
    () =>
      deriveTasks(core?.tasks?.tasks ?? emptyTasks, core?.terminals ?? {}, core?.layout, {}, now),
    [core?.layout, core?.tasks, core?.terminals, now],
  );
  const project = useMemo(
    () => findProject(projectId, core?.layout, taskRows.rows),
    [core?.layout, projectId, taskRows.rows],
  );
  const connection = core?.connection ?? "offline";
  const connectionState = connectionPresentation(connection, machine?.name);
  const rows =
    taskRows.byProject[projectId] ??
    taskRows.rows.filter((row) => row.project.name === project.name);
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

  useEffect(() => {
    if (screenText === undefined || connection !== "connected") return;
    for (const row of view.rows) {
      if (row.state !== "done" || row.address === undefined) continue;
      const key = summaryKey(row);
      if (requestedSummaries.current.has(key)) continue;
      requestedSummaries.current.add(key);
      void screenText
        .read(row.address, { turn: row.terminal?.turn, state: row.terminal?.status?.state })
        .then((screenRows) => {
          setSummaries((previous) => ({
            ...previous,
            [key]:
              summarize(row.program.iconKey, row.terminal?.status, screenRows) ?? "No summary yet.",
          }));
        })
        .catch(() => {
          setSummaries((previous) => ({ ...previous, [key]: "No summary yet." }));
        });
    }
  }, [connection, screenText, view.rows]);

  const openTerminal = (address: string) => router.push(routes.agent(address) as Href);
  const goHome = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.home as Href);
  };

  function beginCheckOff(row: TaskRowModel) {
    if (!view.canCheckOff) return;
    setMessage(undefined);
    if (needsCheckOffSheet(row, machine?.role)) {
      setCheckTask(row);
    } else {
      void runCheckOff(row);
    }
  }

  async function runCheckOff(row: TaskRowModel, choice?: CheckOffChoice) {
    try {
      await applyCheckOff(row, machine?.role, choice, actions);
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
      await actions.clear({ spaceId: projectId });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't clear checked-off tasks.");
    } finally {
      setIsClearing(false);
    }
  }

  async function selectTaskAction(action: ProjectRowAction) {
    const row = selectedTask;
    setSelectedTask(undefined);
    if (row === undefined) return;
    if (action.id === "open-terminal" && row.address !== undefined) openTerminal(row.address);
    if (action.id === "copy-address" && row.address !== undefined) {
      try {
        await actions.copy(row.address);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Couldn't copy the address.");
      }
    }
    if (action.id === "check-off") beginCheckOff(row);
  }

  const selectedActions = selectedTask
    ? projectRowActions(selectedTask, machine?.role, connection)
    : [];
  const checkOptions = checkTask ? checkOffSheetOptions(checkTask, machine?.role) : [];

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

      <ScrollView className="min-h-0 flex-1" showsVerticalScrollIndicator={false}>
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
              onCheckOff={() => beginCheckOff(row)}
              onLongPress={() => {
                if (
                  view.actionsEnabled &&
                  projectRowActions(row, machine?.role, connection).length > 0
                ) {
                  setSelectedTask(row);
                }
              }}
              onPress={() => router.push(routes.task(row.id) as Href)}
              row={row}
              summary={summaries[summaryKey(row)]}
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
      </ScrollView>

      {view.showComposer ? (
        <View
          className="flex-row items-center border-t-border py-2"
          style={{ borderTopWidth: HAIRLINE }}
        >
          <Pressable
            accessibilityRole="button"
            disabled
            className="min-h-11 flex-row items-center gap-2"
          >
            <View className="h-8 w-8 items-center justify-center rounded-full bg-solid">
              <Icon color="solid-fg" name="plus" size={18} />
            </View>
            <Text variant="buttonLarge">New task</Text>
          </Pressable>
        </View>
      ) : null}

      <ActionSheet
        actions={selectedActions}
        onClose={() => setSelectedTask(undefined)}
        onSelect={(action) => void selectTaskAction(action)}
        title={selectedTask?.title ?? "Task actions"}
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
          if (checkTask) void runCheckOff(checkTask, choice);
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
  options: ReturnType<typeof checkOffSheetOptions>;
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
    rows.find((row) => row.project.id === id)?.project ??
    rows.find((row) => row.project.name === id)?.project ?? {
      id,
      name: id === "other" ? "Other" : id,
      folder: undefined,
    }
  );
}

function summaryKey(row: TaskRowModel): string {
  return `${row.address ?? row.id}:${row.terminal?.turn ?? 0}:${row.terminal?.status?.state ?? ""}`;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
