import { Pressable, View } from "react-native";
import { HAIRLINE } from "@/ui/components/classes.ts";
import { StatusMark } from "@/ui/components/StatusMark.tsx";
import { Text } from "@/ui/text.tsx";

const pairButtonClasses = {
  rest: "min-h-11 items-center justify-center rounded-btn border-border bg-surface px-3",
  pressed: "min-h-11 items-center justify-center rounded-btn border-border bg-raised px-3",
} as const;

export interface PairAgainBannerProps {
  message: string;
  onPair(): void;
}

export function PairAgainBanner({ message, onPair }: PairAgainBannerProps) {
  return (
    <View
      className="flex-row items-center gap-3 rounded-group border-border bg-surface px-3.5 py-2.5"
      style={{ borderWidth: HAIRLINE }}
    >
      <StatusMark state="blockedCompact" />
      <View className="min-w-0 flex-1">
        <Text variant="subhead" tone="muted">
          {message}
        </Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onPair}>
        {({ pressed }) => (
          <View
            className={pressed ? pairButtonClasses.pressed : pairButtonClasses.rest}
            style={{ borderWidth: HAIRLINE }}
          >
            <Text variant="button">Pair again</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
