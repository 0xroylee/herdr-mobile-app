import { Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Text } from "../../ui/text.tsx";

export interface KeyProps {
  label: string;
  disabled?: boolean;
  onPress(): void;
}

export function Key({ label, disabled = false, onPress }: KeyProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className="min-h-11 min-w-11 items-center justify-center"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}
    >
      <View
        className="h-8 min-w-10 items-center justify-center rounded-key border-border bg-surface px-2.5"
        style={{ borderWidth: HAIRLINE }}
      >
        <Text style={{ fontSize: 12 }} variant="mono" tone="muted">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
