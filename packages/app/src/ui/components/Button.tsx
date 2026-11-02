import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, type IconName } from "../icon.tsx";
import { Text } from "../text.tsx";
import { buttonClasses, buttonTextTones, HAIRLINE } from "./classes.ts";

export type ButtonVariant = keyof typeof buttonClasses;

export interface ButtonProps {
  children: ReactNode;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function Button({
  children,
  onPress,
  variant = "solid",
  icon,
  disabled = false,
  accessibilityLabel,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      className="min-h-11 min-w-11 items-center justify-center"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}
    >
      {({ pressed }) => {
        const state = pressed && !disabled ? "pressed" : "rest";
        const tone = buttonTextTones[variant][state];
        const iconColor =
          tone === "solid-fg" || tone === "danger-fg" ? tone : tone === "danger" ? "danger" : "fg";

        return (
          <View
            className={buttonClasses[variant][state]}
            style={variant === "outline" ? { borderWidth: HAIRLINE } : undefined}
          >
            <View className="flex-row items-center justify-center gap-2">
              {icon ? (
                <Icon color={iconColor} name={icon} size={variant === "large" ? 19 : 17} />
              ) : null}
              <Text variant={variant === "large" ? "buttonLarge" : "button"} tone={tone}>
                {children}
              </Text>
            </View>
          </View>
        );
      }}
    </Pressable>
  );
}
