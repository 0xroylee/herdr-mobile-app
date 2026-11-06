import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { useComposerController } from "./composer-controller.ts";

export interface ComposerProps {
  program: string;
  placeholder?: string;
  sent: boolean;
  notice?: string;
  readOnly?: boolean;
  disabled?: boolean;
  error?: string;
  onSend(text: string): Promise<boolean>;
}

export function Composer({
  program,
  placeholder,
  sent,
  notice,
  readOnly = false,
  disabled = false,
  error,
  onSend,
}: ComposerProps) {
  const { value, pending: sending, setValue, submit } = useComposerController();
  const dim = useCSSVariable("--color-dim");
  const solidForeground = useCSSVariable("--color-solid-fg");

  return (
    <View className="pb-1">
      {sent ? (
        <View className="mb-1.5 px-1">
          <Text variant="subhead" tone="muted">
            Sent · waiting for {program}
          </Text>
        </View>
      ) : null}
      {notice ? (
        <View className="mb-1.5 px-1">
          <Text variant="subhead">{notice}</Text>
        </View>
      ) : null}
      {error ? (
        <View className="mb-1.5 px-1">
          <Text variant="subhead" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}
      <View
        className="flex-row items-center rounded-field border-border bg-surface p-[9px] pl-[15px]"
        style={{ borderWidth: HAIRLINE }}
      >
        <TextInput
          accessibilityLabel={readOnly ? "Read-only terminal message" : `Message ${program}`}
          className="min-h-8 min-w-0 flex-1 p-0 font-sans text-[15px] leading-[21px] text-fg"
          editable={!readOnly && !disabled && !sending}
          onChangeText={setValue}
          onSubmitEditing={() => void submit(readOnly || disabled, onSend)}
          placeholder={readOnly ? "Watching only" : (placeholder ?? `Message ${program}…`)}
          placeholderTextColor={typeof dim === "string" ? dim : undefined}
          returnKeyType="send"
          value={value}
        />
        {readOnly ? null : (
          <Pressable
            accessibilityLabel="Send message"
            accessibilityRole="button"
            className="min-h-11 min-w-11 items-center justify-center"
            disabled={disabled || sending || value.trim().length === 0}
            onPress={() => void submit(readOnly || disabled, onSend)}
            style={({ pressed }) => ({
              opacity: disabled || sending || value.trim().length === 0 ? 0.4 : pressed ? 0.85 : 1,
            })}
          >
            <View className="h-8 w-8 items-center justify-center rounded-full bg-solid">
              {sending ? (
                <ActivityIndicator
                  color={typeof solidForeground === "string" ? solidForeground : undefined}
                  size="small"
                />
              ) : (
                <Icon color="solid-fg" name="arrow-up" size={17} strokeWidth={2.2} />
              )}
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}
