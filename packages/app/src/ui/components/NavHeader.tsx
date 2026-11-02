import { View } from "react-native";
import { Text } from "../text.tsx";
import { IconButton } from "./IconButton.tsx";

export interface NavHeaderProps {
  title: string;
  subtitle: string;
  onBack: () => void;
  onMore: () => void;
}

export function NavHeader({ title, subtitle, onBack, onMore }: NavHeaderProps) {
  return (
    <View className="min-h-[50px] flex-row items-center">
      <IconButton accessibilityLabel="Back" icon="chevron-left" onPress={onBack} size="back" />
      <View className="min-w-0 flex-1 justify-center">
        <Text numberOfLines={1} variant="title">
          {title}
        </Text>
        <Text numberOfLines={1} variant="subhead">
          {subtitle}
        </Text>
      </View>
      <IconButton accessibilityLabel="More options" icon="ellipsis" onPress={onMore} />
    </View>
  );
}
