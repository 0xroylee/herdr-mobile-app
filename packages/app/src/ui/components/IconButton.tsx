import { Pressable, View } from "react-native";
import { Icon, type IconColor, type IconName, type IconSize } from "../icon.tsx";
import { HAIRLINE, iconButtonClasses } from "./classes.ts";

export type IconButtonVariant = "plain" | "boxed";

export interface IconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  variant?: IconButtonVariant;
  size?: IconSize | number;
  color?: IconColor;
  disabled?: boolean;
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  variant = "plain",
  size = "title",
  color = "muted",
  disabled = false,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      className="h-11 w-11 items-center justify-center"
      disabled={disabled}
      onPress={onPress}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {({ pressed }) => (
        <View
          className={iconButtonClasses[variant][pressed && !disabled ? "pressed" : "rest"]}
          style={variant === "boxed" ? { borderWidth: HAIRLINE } : undefined}
        >
          <Icon color={color} name={icon} size={size} />
        </View>
      )}
    </Pressable>
  );
}
