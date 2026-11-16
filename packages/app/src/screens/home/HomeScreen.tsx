import { type Href, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { deriveStartOptions } from "../../model/startAgent.ts";
import { deriveTasks, type TaskProject } from "../../model/tasks.ts";
import { unavailableBridgeCalls } from "../../net/bridge-calls.ts";
import { routes } from "../../routes.ts";
import { coreStore, machinesStore } from "../../store/platform.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { startableHomeProjects } from "../project/new-task-controller.ts";
import { createHomeProject } from "../project/new-task-port.ts";
import { AddProjectSheet } from "./AddProjectSheet.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { connectionPresentation } from "./connectionPresentation.ts";
import { HomeMenu } from "./HomeMenu.tsx";
import { deriveHomeView, newTaskLabelTone, openHomeNewTaskProject } from "./home-view.ts";
import { MachineChip } from "./MachineChip.tsx";
import { ProjectPickerSheet } from "./ProjectPickerSheet.tsx";
import { ProjectRow } from "./ProjectRow.tsx";
import { SearchField } from "./SearchField.tsx";
import { SmartTiles } from "./SmartTiles.tsx";

const emptyTasks: Record<string, never> = {};
const emptyLastSeen = {};

export function HomeScreen() {
  const router = useRouter();
  const connectionManager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machineRecords = useStore(machinesStore, (state) => state.machines);
  const setActiveId = useStore(machinesStore, (state) => state.setActiveId);
  const coreByMachine = useStore(coreStore, (state) => state.machines);
  const machine = activeId === null ? undefined : machineRecords[activeId];
  const core = activeId === null ? undefined : coreByMachine[activeId];
  const machines = useMemo(() => Object.values(machineRecords), [machineRecords]);
  const connections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(coreByMachine).map(([id, value]) => [id, value.connection]),
      ),
    [coreByMachine],
  );
  const [query, setQuery] = useState("");
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [addProjectVisible, setAddProjectVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const tasks = useMemo(
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
  const connection = core?.connection ?? "offline";
  const view = useMemo(
    () =>
      deriveHomeView({
        rows: tasks.rows,
        terminals: core?.terminals ?? {},
        layout: core?.layout,
        query,
        role: machine?.role,
        connection,
      }),
    [connection, core?.layout, core?.terminals, machine?.role, query, tasks.rows],
  );
  const presentation = connectionPresentation(connection, machine?.name);
  const newTaskProjects: TaskProject[] = useMemo(() => {
    const choices = deriveStartOptions(
      undefined,
      core?.layout,
      core?.terminals ?? {},
      [],
      undefined,
    ).spaceChoices;
    return startableHomeProjects(view.projectInventory, choices, core?.layout);
  }, [core?.layout, core?.terminals, view.projectInventory]);

  async function addProject(name: string, folder: string) {
    return createHomeProject(
      connectionManager?.calls() ?? unavailableBridgeCalls("Not connected to the selected Mac."),
      machine,
      name,
      folder,
    );
  }

  return (
    <View className="flex-1 bg-canvas px-3.5 pt-safe">
      <View className="flex-row items-center gap-2 pb-2.5 pt-1.5">
        <MachineChip
          activeId={activeId}
          connections={connections}
          machines={machines}
          onSelect={setActiveId}
        />
        <HomeMenu
          onPairAgain={() => router.push("/pair" as Href)}
          onSettings={() => router.push("/settings" as Href)}
        />
      </View>

      <ConnectionBanner presentation={presentation} />

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="gap-4 pb-3"
        showsVerticalScrollIndicator={false}
        style={view.dimmed ? { opacity: 0.6 } : undefined}
      >
        <SearchField onChangeText={setQuery} value={query} />
        <SmartTiles tiles={view.tiles} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="title">Projects</Text>
          </View>
          {view.projects.length > 0 ? (
            <ListGroup>
              {view.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  onPress={() => router.push(routes.project(project.id) as Href)}
                  project={project}
                />
              ))}
            </ListGroup>
          ) : (
            <View className="min-h-[200px] items-center justify-center px-6">
              <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
                No projects yet. Spaces you make in Herdr show up here.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {view.showActions ? (
        <View
          className="flex-row items-center justify-between border-t-border py-2"
          style={{ borderTopWidth: 1 }}
        >
          <Pressable
            accessibilityRole="button"
            disabled={!view.actionsEnabled}
            onPress={() => setProjectPickerVisible(true)}
            style={{ opacity: view.actionsEnabled ? 1 : 0.4 }}
          >
            <View className="min-h-11 flex-row items-center gap-2">
              <View className="h-8 w-8 items-center justify-center rounded-full bg-solid">
                <Icon color="solid-fg" name="plus" size={18} />
              </View>
              <Text tone={newTaskLabelTone} variant="buttonLarge">
                New task
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!view.actionsEnabled}
            onPress={() => setAddProjectVisible(true)}
            style={{ opacity: view.actionsEnabled ? 1 : 0.4 }}
          >
            <View className="min-h-11 items-center justify-center px-2">
              <Text variant="button" tone="muted">
                Add project
              </Text>
            </View>
          </Pressable>
        </View>
      ) : null}
      <ProjectPickerSheet
        onClose={() => setProjectPickerVisible(false)}
        onSelect={(projectId) => {
          setProjectPickerVisible(false);
          openHomeNewTaskProject(router, projectId);
        }}
        projects={newTaskProjects}
        visible={projectPickerVisible}
      />
      <AddProjectSheet
        disabled={!view.actionsEnabled}
        onAdd={addProject}
        onClose={() => setAddProjectVisible(false)}
        visible={addProjectVisible}
      />
    </View>
  );
}
