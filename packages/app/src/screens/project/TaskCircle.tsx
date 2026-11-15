import { Pressable, View } from "react-native";
import type { TaskRow as TaskRowModel } from "../../model/tasks.ts";
import { Spinner } from "../../ui/components/Spinner.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";

export function TaskCircle({
  row,
  enabled,
  onPress,
}: {
  row: TaskRowModel;
  enabled: boolean;
  onPress(): void;
}) {
  const accessibilityLabel =
    row.state === "checked" ? `Checked off ${row.title}` : `Check off ${row.title}`;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={!enabled || row.state === "checked" || row.state === "not-started"}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : enabled ? 1 : 0.65 })}
    >
      <View className={circleClasses[row.state]}>
        {row.state === "running" ? (
          <Spinner size={19} />
        ) : row.state === "needs-you" ? (
          <Text variant="markCompact" tone="blocked">
            !
          </Text>
        ) : row.state === "done" ? (
          <View className="h-2 w-2 rounded-full bg-done" />
        ) : row.state === "stopped" ? (
          <Icon color="danger" name="x" size={14} strokeWidth={2.3} />
        ) : row.state === "checked" ? (
          <Icon color="solid-fg" name="check" size={14} strokeWidth={2.5} />
        ) : null}
      </View>
    </Pressable>
  );
}

const circleClasses: Record<TaskRowModel["state"], string> = {
  running: "h-[23px] w-[23px] items-center justify-center",
  "needs-you":
    "h-[23px] w-[23px] items-center justify-center rounded-full border-[1.5px] border-blocked bg-blocked-tint",
  done: "h-[23px] w-[23px] items-center justify-center rounded-full border-[1.5px] border-done",
  stopped:
    "h-[23px] w-[23px] items-center justify-center rounded-full border-[1.5px] border-danger",
  checked: "h-[23px] w-[23px] items-center justify-center rounded-full bg-done",
  "not-started":
    "h-[23px] w-[23px] items-center justify-center rounded-full border-[1.5px] border-dim",
};
