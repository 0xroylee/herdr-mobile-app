import { Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Text } from "../../ui/text.tsx";

export function CheckedBar({
  count,
  shown,
  showClear,
  canClear,
  onToggle,
  onClear,
}: {
  count: number;
  shown: boolean;
  showClear: boolean;
  canClear: boolean;
  onToggle(): void;
  onClear(): void;
}) {
  if (count === 0) return null;

  return (
    <View
      className="min-h-11 flex-row items-center justify-between"
      style={{ borderBottomWidth: HAIRLINE }}
    >
      <View className="flex-row items-center">
        <Text variant="callout" tone="muted">
          {count} checked off
        </Text>
        {showClear ? (
          <>
            <Text variant="callout" tone="muted">
              {" "}
              ·{" "}
            </Text>
            <Pressable accessibilityRole="button" disabled={!canClear} onPress={onClear}>
              <Text variant="button" tone={canClear ? "fg" : "dim"}>
                Clear
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" onPress={onToggle}>
        <Text variant="button" tone="muted">
          {shown ? "Hide" : "Show"}
        </Text>
      </Pressable>
    </View>
  );
}
