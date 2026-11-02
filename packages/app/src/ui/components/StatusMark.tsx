import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Text } from "../text.tsx";
import { statusMarkClasses, statusTextTones } from "./classes.ts";
import { Spinner } from "./Spinner.tsx";

export interface StatusMarkProps {
  state: string;
  compact?: boolean;
}

type MarkState = keyof typeof statusMarkClasses;

function resolveMarkState(state: string, compact: boolean): MarkState {
  if (state === "working") return "working";
  if (state === "done") return "done";
  if (state === "blockedCompact") return "blockedCompact";
  if (state === "blocked" || state === "error") return compact ? "blockedCompact" : "blocked";
  return "idle";
}

export function StatusMark({ state, compact = false }: StatusMarkProps) {
  const markState = resolveMarkState(state, compact);
  const [previousMark, setPreviousMark] = useState(markState);
  const changed = previousMark !== markState;

  useEffect(() => {
    if (changed) setPreviousMark(markState);
  }, [changed, markState]);

  return (
    <Animated.View
      key={markState}
      accessibilityLabel={markState === "blockedCompact" ? "Needs you" : markState}
      accessibilityRole="image"
      className="items-center justify-center"
      entering={changed ? FadeIn.duration(150) : undefined}
    >
      {markState === "working" ? (
        <Spinner size={14} />
      ) : markState === "blocked" ? (
        <View className={statusMarkClasses.blocked}>
          <Text variant="micro" tone={statusTextTones.blocked}>
            Needs you
          </Text>
        </View>
      ) : markState === "blockedCompact" ? (
        <View className={statusMarkClasses.blockedCompact}>
          <Text variant="markCompact" tone={statusTextTones.blockedCompact}>
            !
          </Text>
        </View>
      ) : (
        <View className={statusMarkClasses[markState]} />
      )}
    </Animated.View>
  );
}
