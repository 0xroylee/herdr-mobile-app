import type { StartAgentSpace } from "@herdr-mobile/protocol";
import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import type { FolderSuggestion, StartSpaceChoice } from "../../model/startAgent.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Icon } from "../../ui/icon.tsx";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";
import { FolderPicker } from "./FolderPicker.tsx";

const rowClasses = {
  rest: "min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[58px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export interface WherePickerProps {
  spaces: readonly StartSpaceChoice[];
  selectedSpace: StartAgentSpace | undefined;
  folder: string;
  folders: readonly FolderSuggestion[];
  home: string | undefined;
  disabled: boolean;
  showFolder: boolean;
  spaceError?: string;
  folderError?: string;
  onSpaceChange(space: StartAgentSpace): void;
  onFolderChange(folder: string): void;
}

export function WherePicker({
  spaces,
  selectedSpace,
  folder,
  folders,
  home,
  disabled,
  showFolder,
  spaceError,
  folderError,
  onSpaceChange,
  onFolderChange,
}: WherePickerProps) {
  const [spacePickerVisible, setSpacePickerVisible] = useState(false);
  const spaceName = spaces.find((choice) => sameSpace(choice.selection, selectedSpace))?.name;

  return (
    <View>
      <ListGroup>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => setSpacePickerVisible(true)}
        >
          {({ pressed }) => (
            <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
              <View className="min-w-0 flex-1">
                <Text variant="headline">Space</Text>
                <Text numberOfLines={1} variant="subhead" tone="muted">
                  {spaceName ?? "Choose a space"}
                </Text>
              </View>
              <Icon color="dim" name="chevron-right" size={17} />
            </View>
          )}
        </Pressable>
        {spaceError ? (
          <View className="px-3.5 py-2">
            <Text accessibilityRole="alert" variant="caption" tone="blocked">
              {spaceError}
            </Text>
          </View>
        ) : null}
        {showFolder ? (
          <FolderPicker
            disabled={disabled}
            error={folderError}
            folder={folder}
            home={home}
            onSelect={onFolderChange}
            suggestions={folders}
          />
        ) : null}
      </ListGroup>
      <Modal
        animationType="slide"
        onRequestClose={() => setSpacePickerVisible(false)}
        presentationStyle="pageSheet"
        visible={spacePickerVisible}
      >
        <View className={`flex-1 bg-canvas px-3.5 ${modalFrameTopInsetClass(Platform.OS)}`}>
          <View className="flex-row items-center pb-2.5">
            <IconButton
              accessibilityLabel="Close space picker"
              icon="x"
              onPress={() => setSpacePickerVisible(false)}
            />
            <Text variant="title">Choose space</Text>
          </View>
          <ScrollView className="flex-1" contentContainerClassName="pb-5">
            <ListGroup>
              {spaces.map((choice) => {
                const selected = sameSpace(choice.selection, selectedSpace);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={choice.selection.kind === "existing" ? choice.selection.id : "new"}
                    onPress={() => {
                      onSpaceChange(choice.selection);
                      setSpacePickerVisible(false);
                    }}
                  >
                    {({ pressed }) => (
                      <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                        <View className="min-w-0 flex-1">
                          <Text numberOfLines={1} variant="headline">
                            {choice.name}
                          </Text>
                          {choice.folder ? (
                            <Text numberOfLines={1} variant="subhead" tone="dim">
                              {choice.folder}
                            </Text>
                          ) : null}
                        </View>
                        {selected ? <Icon color="fg" name="check" size={17} /> : null}
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ListGroup>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function sameSpace(left: StartAgentSpace, right: StartAgentSpace | undefined): boolean {
  if (!right || left.kind !== right.kind) return false;
  return left.kind === "existing"
    ? right.kind === "existing" && left.id === right.id
    : right.kind === "new";
}
