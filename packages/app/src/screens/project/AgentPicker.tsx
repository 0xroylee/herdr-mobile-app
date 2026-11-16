import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Modal, Platform, ScrollView, View } from "react-native";
import type { StartRunChoice, StartRunSelection } from "../../model/startAgent.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";
import { RunList } from "./RunList.tsx";
import { transitionPickerVisibility } from "./viewState.ts";

export interface AgentPickerProps {
  choices: readonly StartRunChoice[];
  selected: StartRunSelection | undefined;
  disabled: boolean;
  error?: string;
  trigger(open: () => void): ReactNode;
  onSelect(run: StartRunSelection): void;
}

export function AgentPicker({
  choices,
  selected,
  disabled,
  error,
  trigger,
  onSelect,
}: AgentPickerProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible((current) =>
      transitionPickerVisibility(current, { type: "availability-changed", disabled }),
    );
  }, [disabled]);

  return (
    <>
      <View className={disabled ? "opacity-40" : undefined}>
        {trigger(() => {
          setVisible((current) => transitionPickerVisibility(current, { type: "open", disabled }));
        })}
      </View>
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
              accessibilityLabel="Close agent picker"
              icon="x"
              onPress={() => setVisible(false)}
            />
            <Text variant="title">Choose agent</Text>
          </View>
          <ScrollView className="flex-1" contentContainerClassName="pb-5">
            <RunList
              choices={choices.filter((choice) => choice.kind !== "empty")}
              disabled={disabled}
              error={error}
              onSelect={(run) => {
                onSelect(run);
                setVisible(false);
              }}
              selected={selected}
            />
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
