import { View } from "react-native";
import { Text } from "../text.tsx";
import { Button } from "./Button.tsx";
import { HAIRLINE } from "./classes.ts";
import { Spinner } from "./Spinner.tsx";
import { StatusMark } from "./StatusMark.tsx";

export type BannerState = "reconnecting" | "offline";

export interface BannerProps {
  state: BannerState;
  message: string;
  onRetry?: () => void;
}

export function Banner({ state, message, onRetry }: BannerProps) {
  const retryLabel = "Retry";

  return (
    <View
      className="flex-row items-center gap-3 rounded-group border-border bg-surface px-3.5 py-2.5"
      style={{ borderWidth: HAIRLINE }}
    >
      {state === "reconnecting" ? <Spinner size={14} /> : <StatusMark state="blockedCompact" />}
      <View className="min-w-0 flex-1">
        <Text variant="subhead" tone="muted">
          {message}
        </Text>
      </View>
      {onRetry ? (
        <Button onPress={onRetry} variant="outline">
          {retryLabel}
        </Button>
      ) : null}
    </View>
  );
}
