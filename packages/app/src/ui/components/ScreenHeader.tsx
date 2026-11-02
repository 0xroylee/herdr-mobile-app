import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";

export interface ScreenHeaderProps {
  title: string;
  children?: ReactNode;
}

export function ScreenHeader({ title, children }: ScreenHeaderProps) {
  return (
    <View className="flex-row items-center justify-between px-1 pb-2.5 pt-1.5">
      <View className="flex-1">
        <Text numberOfLines={1} variant="largeTitle">
          {title}
        </Text>
      </View>
      <View className="flex-row items-center gap-1">{children}</View>
    </View>
  );
}
