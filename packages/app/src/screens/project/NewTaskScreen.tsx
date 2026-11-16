import type { StartAgentRun, StartAgentSpace } from "@herdr-mobile/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import type { StartRunSelection } from "../../model/startAgent.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import { coreStore, machinesStore, settingsStore } from "../../store/platform.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { ConnectionBanner } from "../home/ConnectionBanner.tsx";
import { connectionPresentation } from "../home/connectionPresentation.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import {
  createNewTaskDetailsController,
  type NewTaskContext,
  type NewTaskSeed,
  newTaskFolders,
  runNeedsHerdrOpen,
  sameRunSelection,
  submitNewTaskSheet,
} from "./new-task-controller.ts";
import { bindNewTaskController, createNewTaskPort } from "./new-task-port.ts";
import { leaveNewTaskSheet } from "./project-view.ts";
import { WherePicker } from "./WherePicker.tsx";

const emptyRecentFolders: string[] = [];
const emptyTasks: Record<string, never> = {};

export function NewTaskScreen() {
  const params = useLocalSearchParams<{ project?: string | string[]; draft?: string | string[] }>();
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
  const projectId = firstParam(params.project) ?? "other";
  const serializedDraft = firstParam(params.draft);
  const seed = useMemo(() => parseSeed(serializedDraft, projectId), [projectId, serializedDraft]);
  const context = useMemo(
    () =>
      makeContext(
        activeId,
        machine?.role,
        core?.connection === "connected",
        core?.layout,
        core?.terminals ?? {},
        recentFolders,
        lastRun,
      ),
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
  const [initialBinding] = useState(() => ({
    port: createNewTaskPort(
      connectionManager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
      {
        rememberRun: (machineId, run) => settingsStore.getState().setLastRun(machineId, run),
        rememberFolder: (machineId, folder) =>
          settingsStore.getState().pushRecentFolder(machineId, folder),
      },
    ),
    context,
  }));
  const controller = useMemo(
    () =>
      createNewTaskDetailsController(initialBinding.port, initialBinding.context, projectId, seed),
    [initialBinding, projectId, seed],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const connection = core?.connection ?? "offline";
  const presentation = connectionPresentation(connection, machine?.name);
  const selectedRun = state.draft.run;
  const selectedRunChoice = state.options.runChoices.find((choice) =>
    sameRunSelection(choice.selection, selectedRun),
  );
  const canEdit = machine?.role === "control";
  const fieldsDisabled =
    !canEdit || connection !== "connected" || state.status === "starting" || state.loadingCatalog;
  const catalog = state.catalog;
  const selectedProject = state.draft.project;
  const folderSuggestions = newTaskFolders(state.options, selectedProject);
  const home = catalog?.home;
  const agentNeedsWindow = runNeedsHerdrOpen(catalog, selectedRun);
  const dim = useCSSVariable("--color-dim");
  const placeholderColor = typeof dim === "string" ? dim : undefined;

  useEffect(() => {
    bindNewTaskController(controller, connectionManager, context, {
      rememberRun: (machineId, run) => settingsStore.getState().setLastRun(machineId, run),
      rememberFolder: (machineId, folder) =>
        settingsStore.getState().pushRecentFolder(machineId, folder),
    });
  }, [connectionManager, context, controller]);
  useEffect(() => {
    if (
      canEdit &&
      connection === "connected" &&
      !controller.state.catalog &&
      !controller.state.catalogError
    ) {
      void controller.load();
    }
  }, [canEdit, connection, controller]);

  useEffect(() => {
    controller.reconcileTasks(core?.tasks?.tasks ?? emptyTasks, state.optimisticRecords);
  }, [controller, core?.tasks, state.optimisticRecords]);

  async function submitTask() {
    await submitNewTaskSheet(controller, projectId, context.layout, (destination) => {
      leaveNewTaskSheet(router, destination);
    });
  }

  if (!canEdit) {
    return (
      <DetailsFrame>
        <SheetHeader
          onCancel={() => leaveNewTaskSheet(router, { kind: "back" })}
          onAdd={() => undefined}
          busy={false}
          disabled
        />
        <View className="flex-1 items-center justify-center px-6">
          <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
            This device is read-only. Adding tasks is available on control devices.
          </Text>
        </View>
      </DetailsFrame>
    );
  }

  return (
    <DetailsFrame>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SheetHeader
          busy={state.status === "starting"}
          disabled={
            connection !== "connected" || state.status === "starting" || state.loadingCatalog
          }
          onAdd={() => void submitTask()}
          onCancel={() => leaveNewTaskSheet(router, { kind: "back" })}
        />
        {connection !== "connected" ? (
          <View className="px-3.5 pb-2.5">
            <ConnectionBanner presentation={presentation} />
            <Text variant="caption" tone="blocked">
              Can’t reach your Mac.
            </Text>
          </View>
        ) : null}
        {state.catalogError ? (
          <View className="flex-row items-center gap-2 px-3.5 pb-2.5">
            <Text style={{ flex: 1 }} variant="caption" tone="dim">
              Agent options couldn’t load. Built-in programs are available.
            </Text>
            <SmallAction label="Refresh" onPress={() => void controller.load()} />
          </View>
        ) : null}
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          className="min-h-0 flex-1"
          contentContainerClassName="gap-4 px-3.5 pb-safe"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View
            className="gap-2 rounded-card border-border bg-surface p-3.5"
            style={{ borderWidth: HAIRLINE }}
          >
            <TextInput
              accessibilityLabel="Task"
              autoCorrect
              className="min-h-11 p-0 font-sans text-[16px] leading-[22px] text-fg"
              editable={!fieldsDisabled}
              onChangeText={(value) => controller.setText(value)}
              placeholder="Task"
              placeholderTextColor={placeholderColor}
              value={state.draft.text}
            />
            <View className="h-px bg-border" />
            <TextInput
              accessibilityLabel="Notes for the agent"
              autoCorrect
              className="min-h-[82px] p-0 font-sans text-[15px] leading-[21px] text-fg"
              editable={!fieldsDisabled}
              multiline
              onChangeText={(value) => controller.setNotes(value)}
              placeholder="Notes for the agent"
              placeholderTextColor={placeholderColor}
              textAlignVertical="top"
              value={state.draft.notes}
            />
            {state.fieldErrors?.task ? (
              <Text accessibilityRole="alert" variant="caption" tone="blocked">
                {state.fieldErrors.task}
              </Text>
            ) : null}
          </View>

          <View className="gap-2">
            <WherePicker
              choices={state.options.spaceChoices}
              disabled={fieldsDisabled}
              error={state.fieldErrors?.space}
              onSelect={(project) => controller.setProject(project)}
              selected={selectedProject}
            />
            {selectedProject?.kind === "new" ? (
              <View
                className="rounded-card border-border bg-surface px-3.5"
                style={{ borderWidth: HAIRLINE }}
              >
                <TextInput
                  accessibilityLabel="Project name"
                  autoCorrect
                  className="min-h-12 font-sans text-[15px] text-fg"
                  editable={!fieldsDisabled}
                  onChangeText={(name) => controller.setProjectName(name)}
                  placeholder="Name"
                  placeholderTextColor={placeholderColor}
                  value={selectedProject.name ?? ""}
                />
              </View>
            ) : null}

            <AgentPicker
              choices={state.options.runChoices}
              disabled={fieldsDisabled}
              error={state.fieldErrors?.run}
              onSelect={(run: StartRunSelection) => controller.setRun(run)}
              selected={selectedRun}
              trigger={(open) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: fieldsDisabled }}
                  className="flex-row items-center gap-3 rounded-card border-border bg-surface px-3.5 py-3"
                  disabled={fieldsDisabled}
                  onPress={open}
                  style={{ borderWidth: HAIRLINE, opacity: fieldsDisabled ? 0.4 : 1 }}
                >
                  <View className="min-w-0 flex-1">
                    <Text variant="headline">Agent</Text>
                    <Text numberOfLines={1} variant="subhead" tone="muted">
                      {selectedRunChoice?.name ?? "Choose an agent"}
                    </Text>
                    {agentNeedsWindow ? (
                      <Text variant="caption" tone="dim">
                        needs Herdr open
                      </Text>
                    ) : null}
                  </View>
                  <Icon color="dim" name="chevron-right" size={17} />
                </Pressable>
              )}
            />

            <FolderPicker
              disabled={fieldsDisabled}
              error={state.fieldErrors?.folder}
              folder={state.draft.folder}
              home={home}
              onSelect={(folder) => controller.setFolder(folder)}
              openRequest={state.folderPickerRequest}
              suggestions={folderSuggestions}
            />
          </View>

          {state.error && !state.fieldErrors?.task && !state.fieldErrors?.folder ? (
            <View className="flex-row items-center gap-2">
              <Text accessibilityRole="alert" style={{ flex: 1 }} variant="caption" tone="blocked">
                {state.error}
              </Text>
              {state.refreshAvailable ? (
                <SmallAction label="Refresh" onPress={() => void controller.load()} />
              ) : (
                <SmallAction label="Retry" onPress={() => void submitTask()} />
              )}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </DetailsFrame>
  );
}

function DetailsFrame({ children }: { children: ReactNode }) {
  const isWeb = Platform.OS === "web";
  return (
    <View
      className={
        isWeb
          ? "flex-1 items-center justify-center bg-canvas px-6 py-6"
          : "flex-1 bg-canvas pt-safe"
      }
    >
      <View
        className={
          isWeb
            ? "flex-1 w-full max-w-[620px] overflow-hidden rounded-card border-border bg-canvas"
            : "flex-1 bg-canvas"
        }
      >
        {children}
      </View>
    </View>
  );
}

function SheetHeader({
  onCancel,
  onAdd,
  busy,
  disabled,
}: {
  onCancel(): void;
  onAdd(): void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <View className="min-h-14 flex-row items-center justify-between px-3.5">
      <Pressable accessibilityRole="button" className="min-h-11 justify-center" onPress={onCancel}>
        <Text variant="button" tone="muted">
          Cancel
        </Text>
      </Pressable>
      <Text numberOfLines={1} variant="title">
        New task
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled }}
        className="min-h-11 min-w-11 items-center justify-center"
        disabled={disabled}
        onPress={onAdd}
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        <Text variant="button" tone="fg">
          {busy ? "Adding…" : "Add"}
        </Text>
      </Pressable>
    </View>
  );
}

function SmallAction({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Text variant="button" tone="muted">
        {label}
      </Text>
    </Pressable>
  );
}

function makeContext(
  machineId: string | null,
  role: NewTaskContext["role"],
  connected: boolean,
  layout: NewTaskContext["layout"],
  terminals: NewTaskContext["terminals"],
  recentFolders: readonly string[],
  lastRun: StartAgentRun | undefined,
): NewTaskContext {
  return {
    machineId: machineId ?? undefined,
    role,
    connected,
    layout,
    terminals,
    recentFolders,
    lastRun,
  };
}

function parseSeed(value: string | undefined, projectId: string): NewTaskSeed {
  const fallback: NewTaskSeed = { project: { kind: "existing", id: projectId } };
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    const draft = parsed as Record<string, unknown>;
    const project = isStartSpace(draft.project) ? draft.project : fallback.project;
    const run = isStartRun(draft.run) ? draft.run : undefined;
    return {
      text: typeof draft.text === "string" ? draft.text : "",
      notes: typeof draft.notes === "string" ? draft.notes : "",
      folder: typeof draft.folder === "string" ? draft.folder : "",
      ...(run ? { run } : {}),
      project,
    };
  } catch {
    return fallback;
  }
}

function isStartSpace(value: unknown): value is StartAgentSpace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "existing"
    ? typeof record.id === "string"
    : record.kind === "new" && (record.name === undefined || typeof record.name === "string");
}

function isStartRun(value: unknown): value is StartAgentRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "program"
    ? typeof record.id === "string"
    : record.kind === "template" && typeof record.name === "string";
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
