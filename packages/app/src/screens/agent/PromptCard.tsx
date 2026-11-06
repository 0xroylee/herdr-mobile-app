import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import type { Prompt } from "../../model/prompt.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { Text } from "../../ui/text.tsx";

export interface PromptCardProps {
  prompt: Prompt;
  program: string;
  age: string;
  sent: boolean;
  pending?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  optionsOffered: boolean;
  onChoice(keys: readonly string[]): void;
  onDismiss(): void;
}

export function PromptCard({
  prompt,
  program,
  age,
  sent,
  pending = false,
  readOnly = false,
  disabled = false,
  optionsOffered,
  onChoice,
  onDismiss,
}: PromptCardProps) {
  const { height } = useWindowDimensions();
  const showChoices = !sent && !pending && (readOnly || optionsOffered);
  const showTypeInstead = !readOnly && !sent && !pending && optionsOffered;

  return (
    <View
      className="mb-2.5 gap-2.5 rounded-card border-prompt-border bg-prompt-bg px-3.5 py-[13px]"
      style={{ borderWidth: HAIRLINE }}
    >
      <View className="flex-row items-center gap-2">
        <StatusMark state="blocked" />
        <View className="min-w-0 flex-1">
          <Text variant="subhead" tone="muted">
            {program}
          </Text>
        </View>
        <Text variant="subhead">{age}</Text>
        {showTypeInstead ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center pl-2"
            onPress={onDismiss}
          >
            <Text variant="subhead" tone="muted">
              Type instead
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text variant="headline">{prompt.question}</Text>
      {prompt.detail ? (
        <Text variant="mono" tone="muted">
          {prompt.detail}
        </Text>
      ) : null}
      {pending ? (
        <Text variant="subhead" tone="muted">
          Sending…
        </Text>
      ) : showChoices ? (
        <ScrollView style={{ maxHeight: height * 0.4 }} showsVerticalScrollIndicator>
          <ListGroup>
            {prompt.choices.map((choice, index) => {
              const rowDisabled = readOnly || disabled;
              return (
                <Pressable
                  key={choice.keys.join(",")}
                  accessibilityLabel={`${index + 1}. ${choice.label}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: rowDisabled }}
                  className="min-h-11 flex-row items-center gap-3 px-3 py-2.5"
                  disabled={rowDisabled}
                  onPress={() => onChoice(choice.keys)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                >
                  <Text variant="mono" tone="dim">
                    {index + 1}
                  </Text>
                  <View className="min-w-0 flex-1">
                    <Text variant="body">{choice.label}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ListGroup>
        </ScrollView>
      ) : null}
    </View>
  );
}
