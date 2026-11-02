import { Modal, Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Text } from "../../ui/text.tsx";

export interface MoreMenuProps {
  visible: boolean;
  takeoverDisabled?: boolean;
  actionsDisabled?: boolean;
  onClose(): void;
  onTakeOver(): void;
  onInterrupt(): void;
  onCopyAddress(): void;
  onEndTerminal(): void;
}

export function MoreMenu({
  visible,
  takeoverDisabled = false,
  actionsDisabled = false,
  onClose,
  onTakeOver,
  onInterrupt,
  onCopyAddress,
  onEndTerminal,
}: MoreMenuProps) {
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel="Close options" className="flex-1" onPress={onClose} />
        <View
          className="gap-1 rounded-t-card border-border bg-surface px-4 pb-safe pt-3"
          style={{ borderWidth: HAIRLINE }}
        >
          <View className="mb-1 flex-row items-center justify-between">
            <Text variant="headline">Terminal actions</Text>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 min-w-11 items-center justify-center"
              onPress={onClose}
            >
              <Text variant="button" tone="dim">
                Done
              </Text>
            </Pressable>
          </View>
          <MenuRow disabled={takeoverDisabled} label="Take over" onPress={() => run(onTakeOver)} />
          <MenuRow disabled={actionsDisabled} label="Interrupt" onPress={() => run(onInterrupt)} />
          <MenuRow label="Copy address" onPress={() => run(onCopyAddress)} />
          <MenuRow
            danger
            disabled={actionsDisabled}
            label="End terminal"
            onPress={() => run(onEndTerminal)}
          />
        </View>
      </View>
    </Modal>
  );
}

function MenuRow({
  label,
  danger = false,
  disabled = false,
  onPress,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-12 justify-center rounded-btn px-3"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}
    >
      <Text variant="body" tone={danger ? "danger" : "fg"}>
        {label}
      </Text>
    </Pressable>
  );
}
