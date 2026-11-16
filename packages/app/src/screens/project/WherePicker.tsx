import type { StartAgentSpace } from "@herdr-mobile/protocol";
import { useEffect, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import type { StartSpaceChoice } from "../../model/startAgent.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Icon } from "../../ui/icon.tsx";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";
import { sameProjectSelection } from "./new-task-controller.ts";
import { transitionPickerVisibility } from "./viewState.ts";

const rowClasses = {
  rest: "min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[58px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export interface WherePickerProps {
  choices: readonly StartSpaceChoice[];
  selected: StartAgentSpace | undefined;
  disabled: boolean;
  error?: string;
  onSelect(project: StartAgentSpace): void;
}

export function WherePicker({ choices, selected, disabled, error, onSelect }: WherePickerProps) {
  const [visible, setVisible] = useState(false);
  const name = choices.find((choice) => sameProjectSelection(choice.selection, selected))?.name;

  useEffect(() => {
    setVisible((current) =>
      transitionPickerVisibility(current, { type: "availability-changed", disabled }),
    );
  }, [disabled]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() =>
          setVisible((current) => transitionPickerVisibility(current, { type: "open", disabled }))
        }
      >
        {({ pressed }) => (
          <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
            <View className="min-w-0 flex-1">
              <Text variant="headline">Project</Text>
              <Text numberOfLines={1} variant="subhead" tone="muted">
                {selected?.kind === "new"
                  ? selected.name?.trim() || "New project"
                  : (name ?? "Choose a project")}
              </Text>
            </View>
            <Icon color="dim" name="chevron-right" size={17} />
          </View>
        )}
      </Pressable>
      {error ? (
        <View className="px-3.5 pb-2.5">
          <Text accessibilityRole="alert" variant="caption" tone="blocked">
            {error}
          </Text>
        </View>
      ) : null}
      <Modal
        animationType="slide"
        onRequestClose={() =>
          setVisible((current) => transitionPickerVisibility(current, { type: "close" }))
        }
        presentationStyle="pageSheet"
        visible={visible && !disabled}
      >
        <View className={`flex-1 bg-canvas px-3.5 ${modalFrameTopInsetClass(Platform.OS)}`}>
          <View className="flex-row items-center pb-2.5">
            <IconButton
              accessibilityLabel="Close project picker"
              icon="x"
              onPress={() => setVisible(false)}
            />
            <Text variant="title">Choose project</Text>
          </View>
          <ScrollView className="flex-1" contentContainerClassName="pb-5">
            <ListGroup>
              {choices.map((choice) => {
                const isNew = choice.selection.kind === "new";
                const selectedChoice = sameProjectSelection(choice.selection, selected);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled, selected: selectedChoice }}
                    disabled={disabled}
                    key={choice.selection.kind === "existing" ? choice.selection.id : "new"}
                    onPress={() => {
                      onSelect(choice.selection);
                      setVisible(false);
                    }}
                  >
                    {({ pressed }) => (
                      <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                        <View className="min-w-0 flex-1">
                          <Text numberOfLines={1} variant="headline">
                            {isNew ? "New project" : choice.name}
                          </Text>
                          {!isNew && choice.folder ? (
                            <Text numberOfLines={1} variant="subhead" tone="dim">
                              {choice.folder}
                            </Text>
                          ) : null}
                        </View>
                        {selectedChoice ? <Icon color="fg" name="check" size={17} /> : null}
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ListGroup>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
