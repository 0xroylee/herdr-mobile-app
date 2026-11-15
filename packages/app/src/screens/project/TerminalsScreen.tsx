import type { Layout } from "@herdr-mobile/protocol";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";
import { useStore } from "zustand";
import { deriveSpaces } from "../../model/spaces.ts";
import { deriveTasks, type TaskProject } from "../../model/tasks.ts";
import { routes } from "../../routes.ts";
import { coreStore, machinesStore } from "../../store/platform.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";
import { TerminalsList } from "./TerminalsList.tsx";

const emptyTasks: Record<string, never> = {};

export function TerminalsScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const router = useRouter();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const core = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const projectId = firstParam(params.id) ?? "other";
  const taskRows = useMemo(
    () =>
      deriveTasks(
        core?.tasks?.tasks ?? emptyTasks,
        core?.terminals ?? {},
        core?.layout,
        {},
        Date.now(),
      ),
    [core?.layout, core?.tasks, core?.terminals],
  );
  const project = projectFor(projectId, core?.layout, taskRows.rows);
  const space = deriveSpaces(core?.terminals ?? {}, core?.layout)
    .flatMap((group) => (group.machine === undefined ? group.spaces : []))
    .find((candidate) => candidate.id === projectId || candidate.name === project.name);
  const openTerminal = (address: string) => router.push(routes.agent(address) as Href);

  return (
    <View className="flex-1 bg-canvas px-3.5 pt-safe">
      <View className="flex-row items-center gap-2 pb-3 pt-1.5">
        <IconButton
          accessibilityLabel="Back to project"
          icon="chevron-left"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace(routes.project(projectId) as Href);
          }}
          size="back"
        />
        <View className="min-w-0 flex-1">
          <Text variant="title">Terminals</Text>
          <Text numberOfLines={1} variant="subhead">
            {project.name}
            {machine?.name ? ` · ${machine.name}` : ""}
          </Text>
        </View>
      </View>
      <TerminalsList onOpenTerminal={openTerminal} tabs={space?.tabs ?? []} />
    </View>
  );
}

function projectFor(
  id: string,
  layout: Layout | undefined,
  rows: ReturnType<typeof deriveTasks>["rows"],
): TaskProject {
  const space = layout?.spaces.find((candidate) => candidate.id === id);
  if (space) {
    const folder = space.folder ?? undefined;
    return {
      id,
      name: space.name.trim() || folder?.split(/[\\/]/u).filter(Boolean).at(-1) || "Other",
      folder,
    };
  }
  return (
    rows.find((row) => row.project.id === id)?.project ?? {
      id,
      name: id === "other" ? "Other" : id,
      folder: undefined,
    }
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
