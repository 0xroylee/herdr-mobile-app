import { View } from "react-native";
import type { Prompt } from "../../model/prompt.ts";
import { Button } from "../../ui/components/Button.tsx";
import { HAIRLINE } from "../../ui/components/classes.ts";
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
  onChoice(keys: readonly string[]): void;
}

export function PromptCard({
  prompt,
  program,
  age,
  sent,
  pending = false,
  readOnly = false,
  disabled = false,
  onChoice,
}: PromptCardProps) {
  return (
    <View
      className="mb-2.5 gap-2.5 rounded-card border-prompt-border bg-prompt-bg px-3.5 py-[13px]"
      style={{ borderWidth: HAIRLINE }}
    >
      <View className="flex-row items-center gap-2">
        <StatusMark state="blocked" />
        <View className="flex-1">
          <Text variant="subhead" tone="muted">
            {program}
          </Text>
        </View>
        <Text variant="subhead">{age}</Text>
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
      ) : sent || readOnly ? null : (
        <View className="flex-row flex-wrap gap-2">
          {prompt.choices.map((choice, index) => (
            <Button
              key={choice.keys.join(",")}
              disabled={disabled}
              onPress={() => onChoice(choice.keys)}
              variant={index === 0 ? "solid" : "outline"}
            >
              {choice.label}
            </Button>
          ))}
        </View>
      )}
    </View>
  );
}
