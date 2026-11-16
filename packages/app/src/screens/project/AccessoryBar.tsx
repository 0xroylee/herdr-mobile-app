import type { AgentCatalog, StartAgentSpace } from "@herdr-mobile/protocol";
import { Pressable, View } from "react-native";
import type { FolderSuggestion, StartOptions, StartRunSelection } from "../../model/startAgent.ts";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { runNeedsHerdrOpen, sameRunSelection } from "./new-task-controller.ts";
import { accessoryBarView } from "./project-view.ts";

interface AccessoryBarProps {
  catalog: AgentCatalog | undefined;
  options: StartOptions;
  run: StartRunSelection | undefined;
  folder: string;
  project: StartAgentSpace | undefined;
  home: string | undefined;
  disabled: boolean;
  folderError?: string;
  folderPickerRequest: number;
  onRun(run: StartRunSelection): void;
  onFolder(folder: string): void;
  onDetails(): void;
}

export function AccessoryBar({
  catalog,
  options,
  run,
  folder,
  project,
  home,
  disabled,
  folderError,
  folderPickerRequest,
  onRun,
  onFolder,
  onDetails,
}: AccessoryBarProps) {
  const runChoice = options.runChoices.find((choice) => sameRunSelection(choice.selection, run));
  const needsWindow = runNeedsHerdrOpen(catalog, run);
  const folders: readonly FolderSuggestion[] =
    options.foldersBySpace[project?.kind === "existing" ? project.id : "new"] ?? [];
  const bar = accessoryBarView({
    agentName: runChoice?.name,
    folder,
    home,
    disabled,
  });

  return (
    <View className="flex-row items-center gap-2 border-t-border bg-chrome px-2.5 py-2">
      <View className="min-w-0 flex-1 gap-1">
        <AgentPicker
          choices={options.runChoices}
          disabled={disabled}
          onSelect={onRun}
          selected={run}
          trigger={(open) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              className="min-w-0"
              disabled={disabled}
              onPress={open}
              style={{ opacity: disabled ? 0.4 : 1 }}
            >
              <View
                className="h-8 min-w-0 flex-row items-center gap-1.5 rounded-full border-border bg-surface px-2.5"
                style={{ borderWidth: 1 }}
              >
                {runChoice ? (
                  <ProgramIcon program={runChoice.program ?? runChoice.name} size="pane" />
                ) : null}
                <Text
                  style={{ flex: 1, minWidth: 0 }}
                  numberOfLines={bar.labelLines}
                  variant="caption"
                  tone="fg"
                >
                  {bar.agentLabel}
                </Text>
                <Icon color="dim" name="chevron-down" size={15} />
              </View>
            </Pressable>
          )}
        />
        {needsWindow ? (
          <Text numberOfLines={1} variant="tag" tone="dim">
            needs Herdr open
          </Text>
        ) : null}
      </View>
      <View className="min-w-0 flex-1">
        <FolderPicker
          disabled={disabled}
          error={folderError}
          folder={folder}
          home={home}
          onSelect={onFolder}
          openRequest={folderPickerRequest}
          suggestions={folders}
          trigger={
            <View
              className="h-8 min-w-0 flex-row items-center gap-1.5 rounded-full border-border bg-surface px-2.5"
              style={{ borderWidth: 1 }}
            >
              <Text
                style={{ flex: 1, minWidth: 0 }}
                numberOfLines={bar.labelLines}
                variant="caption"
                tone={folder ? "fg" : "muted"}
              >
                {bar.folderLabel}
              </Text>
              <Icon color="dim" name="chevron-down" size={15} />
            </View>
          }
        />
      </View>
      <Pressable
        accessibilityLabel="Add task details"
        accessibilityRole="button"
        accessibilityState={{ disabled: bar.detailsDisabled }}
        disabled={bar.detailsDisabled}
        onPress={onDetails}
        className="h-8 w-8 items-center justify-center rounded-full"
        style={{ opacity: bar.detailsDisabled ? 0.4 : 1, flexShrink: 0 }}
      >
        <Text variant="buttonLarge" tone="muted">
          ⓘ
        </Text>
      </Pressable>
    </View>
  );
}
