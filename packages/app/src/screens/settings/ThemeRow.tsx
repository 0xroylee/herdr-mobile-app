import { Pressable, View } from "react-native";
import { settingsStore } from "../../store/platform.ts";
import type { ThemeChoice } from "../../store/settings.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Text } from "../../ui/text.tsx";
import { applyTheme } from "../../ui/theme.ts";

const options: { label: string; value: ThemeChoice }[] = [
  { label: "System", value: "system" },
  { label: "Graphite", value: "graphite" },
  { label: "Paper", value: "paper" },
];

const optionClasses = {
  selected: "h-11 w-full items-center justify-center rounded-btn bg-surface px-2",
  selectedPressed: "h-11 w-full items-center justify-center rounded-btn bg-raised px-2",
  idle: "h-11 w-full items-center justify-center rounded-btn px-2",
  idlePressed: "h-11 w-full items-center justify-center rounded-btn bg-raised px-2",
} as const;

export function ThemeRow() {
  const theme = settingsStore((state) => state.ui.theme);

  const selectTheme = (value: ThemeChoice) => {
    settingsStore.getState().setTheme(value);
    applyTheme(value);
  };

  return (
    <View
      className="gap-2 rounded-group border-border bg-surface p-3.5"
      style={{ borderWidth: HAIRLINE }}
    >
      <Text variant="headline">Theme</Text>
      <View
        className="flex-row rounded-seg border-border bg-canvas p-1"
        style={{ borderWidth: HAIRLINE }}
      >
        {options.map((option) => {
          const selected = theme === option.value;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              className="min-h-11 flex-1"
              key={option.value}
              onPress={() => selectTheme(option.value)}
            >
              {({ pressed }) => (
                <View
                  className={
                    optionClasses[
                      selected
                        ? pressed
                          ? "selectedPressed"
                          : "selected"
                        : pressed
                          ? "idlePressed"
                          : "idle"
                    ]
                  }
                >
                  <Text variant="button" tone={selected ? "fg" : "muted"}>
                    {option.label}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
