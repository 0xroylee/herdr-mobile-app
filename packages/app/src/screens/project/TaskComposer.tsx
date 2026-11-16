import type { ComponentRef } from "react";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import type { NewTaskController, NewTaskControllerState } from "./new-task-controller.ts";

export interface TaskComposerProps {
  controller: NewTaskController;
  state: NewTaskControllerState;
  focusRequest: number;
  disabled: boolean;
  onGo(): void;
  onRetry(): void;
  onRefresh(): void;
}

export function TaskComposer({
  controller,
  state,
  focusRequest,
  disabled,
  onGo,
  onRetry,
  onRefresh,
}: TaskComposerProps) {
  const titleInput = useRef<ComponentRef<typeof TextInput>>(null);
  const dim = useCSSVariable("--color-dim");
  const placeholderColor = typeof dim === "string" ? dim : undefined;
  const starting = state.status === "starting";
  const controlsDisabled = disabled || starting || state.loadingCatalog;

  useEffect(() => {
    if (focusRequest > 0) requestAnimationFrame(() => titleInput.current?.focus());
  }, [focusRequest]);

  return (
    <View>
      {state.catalogError ? (
        <View className="flex-row items-center gap-2 px-1.5 py-2">
          <Text style={{ flex: 1 }} variant="caption" tone="dim">
            Agent options couldn’t load. Built-in programs are available.
          </Text>
          <SmallAction label="Refresh" onPress={onRefresh} />
        </View>
      ) : null}
      <View className="flex-row gap-3 border-t-border px-1.5 py-3" style={{ borderTopWidth: 1 }}>
        <View
          className="mt-1 h-[23px] w-[23px] items-center justify-center rounded-full border-dim"
          style={{ borderWidth: 1 }}
        >
          {starting ? <ActivityIndicator size="small" /> : null}
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="Task"
              autoCorrect
              className="min-h-7 min-w-0 flex-1 p-0 font-sans text-[16px] leading-[21px] text-fg"
              editable={!controlsDisabled}
              onChangeText={(value) => controller.setText(value)}
              onSubmitEditing={onGo}
              placeholder="Task"
              placeholderTextColor={placeholderColor}
              ref={titleInput}
              returnKeyType="go"
              value={state.draft.text}
            />
            {starting ? <ActivityIndicator size="small" /> : null}
          </View>
          <TextInput
            accessibilityLabel="Add details for the agent"
            className="min-h-6 p-0 font-sans text-[14px] leading-[19px] text-fg"
            editable={!controlsDisabled}
            multiline
            onChangeText={(value) => controller.setNotes(value)}
            placeholder="Add details for the agent"
            placeholderTextColor={placeholderColor}
            textAlignVertical="top"
            value={state.draft.notes}
          />
          {state.error && !state.fieldErrors?.folder ? (
            <View className="flex-row items-center gap-2 pt-1">
              <Text accessibilityRole="alert" style={{ flex: 1 }} variant="caption" tone="blocked">
                {state.error}
              </Text>
              {state.refreshAvailable ? (
                <SmallAction label="Refresh" onPress={onRefresh} />
              ) : (
                <SmallAction label="Retry" onPress={onRetry} />
              )}
            </View>
          ) : null}
        </View>
        {!starting ? (
          <Pressable
            accessibilityLabel="go"
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
            className="h-9 w-9 items-center justify-center rounded-full bg-solid"
            disabled={controlsDisabled}
            onPress={onGo}
            style={{ opacity: controlsDisabled ? 0.4 : 1 }}
          >
            <Icon color="solid-fg" name="arrow-up" size={18} />
          </Pressable>
        ) : null}
      </View>
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
