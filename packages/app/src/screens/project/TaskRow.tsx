import { Pressable, View } from "react-native";
import type { TaskRow as TaskRowModel } from "../../model/tasks.ts";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { Tag } from "../../ui/components/Tag.tsx";
import { Text } from "../../ui/text.tsx";
import { TaskCircle } from "./TaskCircle.tsx";

export interface TaskRowProps {
  row: TaskRowModel;
  summary?: string;
  canCheckOff: boolean;
  onCheckOff(): void;
  onPress(): void;
  onLongPress(): void;
}

export function TaskRow({
  row,
  summary,
  canCheckOff,
  onCheckOff,
  onPress,
  onLongPress,
}: TaskRowProps) {
  const detail =
    row.state === "needs-you"
      ? row.question
      : row.state === "done" || row.state === "stopped"
        ? summary
        : undefined;

  return (
    <View>
      <View className="flex-row items-start gap-3 px-1.5 py-2.5">
        <View className="pt-0.5">
          <TaskCircle enabled={canCheckOff} onPress={onCheckOff} row={row} />
        </View>
        <Pressable
          accessibilityRole="button"
          className="min-w-0 flex-1"
          onLongPress={onLongPress}
          onPress={onPress}
        >
          <Text
            numberOfLines={2}
            style={row.checked ? { textDecorationLine: "line-through" } : undefined}
            tone={row.checked ? "dim" : "fg"}
            variant="headline"
          >
            {row.title}
          </Text>
          <View className="mt-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
            <ProgramIcon program={row.program.name} />
            <Text variant="caption">{row.program.name}</Text>
            {row.age ? (
              <Text variant="caption" tone="dim">
                · {row.age}
              </Text>
            ) : null}
            {row.fromHerdr ? <Tag label="from Herdr" /> : null}
          </View>
          {row.state === "stopped" && row.stoppedText ? (
            <Text style={{ marginTop: 4 }} numberOfLines={2} tone="danger" variant="callout">
              {row.stoppedText}
            </Text>
          ) : null}
          {detail ? (
            <Text style={{ marginTop: 4 }} numberOfLines={2} tone="muted" variant="callout">
              {detail}
            </Text>
          ) : null}
        </Pressable>
      </View>
      <View className="ml-[38px] bg-border" style={{ height: 1 }} />
    </View>
  );
}
