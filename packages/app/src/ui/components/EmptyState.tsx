import { View } from "react-native";
import { Text } from "../text.tsx";

export type EmptyStateKind = "agents" | "spaces";

export interface EmptyStateProps {
  kind: EmptyStateKind;
}

const emptyStateCopy: Record<EmptyStateKind, string> = {
  agents:
    "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.",
  spaces: "No spaces yet. Spaces you make in Herdr show up here.",
};

export function EmptyState({ kind }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
        {emptyStateCopy[kind]}
      </Text>
    </View>
  );
}
