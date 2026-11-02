import { Pressable, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";

const clearButtonClasses = {
  rest: "min-h-11 min-w-11 items-center justify-center rounded-btn bg-surface",
  pressed: "min-h-11 min-w-11 items-center justify-center rounded-btn bg-raised",
} as const;

export interface SearchFieldProps {
  value: string;
  onChangeText(value: string): void;
}

export function SearchField({ value, onChangeText }: SearchFieldProps) {
  const placeholderColor = useCSSVariable("--color-dim");

  return (
    <View
      className="min-h-11 flex-row items-center gap-2.5 rounded-field border-border bg-surface px-3.5"
      style={{ borderWidth: HAIRLINE }}
    >
      <Icon color="dim" name="search" size={17} />
      <TextInput
        accessibilityLabel="Search agents by title, space, or program"
        autoCapitalize="none"
        autoCorrect={false}
        className="min-w-0 flex-1 font-sans text-[15px] leading-[21px] text-fg"
        onChangeText={onChangeText}
        placeholder="Search title, space, or program"
        placeholderTextColor={typeof placeholderColor === "string" ? placeholderColor : undefined}
        returnKeyType="search"
        value={value}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityLabel="Clear search"
          accessibilityRole="button"
          onPress={() => onChangeText("")}
        >
          {({ pressed }) => (
            <View className={pressed ? clearButtonClasses.pressed : clearButtonClasses.rest}>
              <Text variant="title" tone="dim">
                ×
              </Text>
            </View>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
