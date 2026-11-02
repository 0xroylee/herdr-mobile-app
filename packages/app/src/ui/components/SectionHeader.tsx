import { View } from "react-native";
import { Text, type TextTone } from "../text.tsx";

export interface SectionHeaderProps {
  title: string;
  count: number | string;
  tone?: TextTone;
}

export function SectionHeader({ title, count, tone = "dim" }: SectionHeaderProps) {
  return (
    <View className="flex-row items-center gap-1.75 px-1 pb-2 pt-3.5">
      <Text variant="section" tone={tone}>
        {title}
      </Text>
      <Text variant="sectionCount" tone="dim">
        {count}
      </Text>
    </View>
  );
}
