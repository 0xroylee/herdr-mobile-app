import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import type { NewItemResult } from "../../net/new-items.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";

export function AddProjectSheet({
  visible,
  disabled,
  onClose,
  onAdd,
}: {
  visible: boolean;
  disabled: boolean;
  onClose(): void;
  onAdd(name: string, folder: string): Promise<NewItemResult>;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dim = useCSSVariable("--color-dim");
  const placeholderColor = typeof dim === "string" ? dim : undefined;

  async function add() {
    if (disabled || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await onAdd(name.trim(), folder.trim());
    setBusy(false);
    if (result.ok) {
      setName("");
      setFolder("");
      onClose();
      return;
    }
    setError(result.message.replace("Herdr isn't", "Herdr isn’t"));
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View className={`flex-1 bg-canvas px-3.5 ${modalFrameTopInsetClass(Platform.OS)}`}>
        <View className="flex-row items-center justify-between pb-2.5">
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            onPress={onClose}
          >
            <Text variant="button" tone="muted">
              Cancel
            </Text>
          </Pressable>
          <Text variant="title">Add project</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: disabled || busy }}
            className="min-h-11 min-w-11 items-center justify-center"
            disabled={disabled || busy}
            onPress={() => void add()}
            style={{ opacity: disabled || busy ? 0.4 : 1 }}
          >
            <Text variant="button">{busy ? "Adding…" : "Add"}</Text>
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          className="flex-1"
          contentContainerClassName="gap-4 pb-5"
          keyboardShouldPersistTaps="handled"
        >
          <View
            className="rounded-card border-border bg-surface px-3.5"
            style={{ borderWidth: HAIRLINE }}
          >
            <TextInput
              accessibilityLabel="Name"
              autoCorrect
              className="min-h-12 font-sans text-[15px] text-fg"
              editable={!disabled && !busy}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor={placeholderColor}
              value={name}
            />
          </View>
          <View
            className="rounded-card border-border bg-surface px-3.5"
            style={{ borderWidth: HAIRLINE }}
          >
            <Text variant="caption" tone="muted">
              Folder
            </Text>
            <TextInput
              accessibilityLabel="Folder"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-12 font-mono text-[13px] text-fg"
              editable={!disabled && !busy}
              onChangeText={setFolder}
              placeholder="~/src/project"
              placeholderTextColor={placeholderColor}
              value={folder}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" variant="caption" tone="blocked">
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
