import { View } from "react-native";
import { Text } from "../text.tsx";
import { HAIRLINE } from "./classes.ts";

export interface TagProps {
  label: string;
}

export function Tag({ label }: TagProps) {
  return (
    <View className="rounded-xs border-border px-1.5 py-px" style={{ borderWidth: HAIRLINE }}>
      <Text variant="tag">{label}</Text>
    </View>
  );
}
