import { Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Spinner } from "../../ui/components/Spinner.tsx";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import type { HomeProject } from "./home-view.ts";

export function ProjectRow({ project, onPress }: { project: HomeProject; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <View
          className={`min-h-[54px] flex-row items-center gap-3 px-3 ${pressed ? "bg-raised" : "bg-surface"}`}
        >
          <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-raised">
            <Text variant="mono" tone="muted">
              {project.name.slice(0, 1).toLocaleUpperCase()}
            </Text>
          </View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} variant="headline">
              {project.name}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <ProjectMark mark={project.mark} />
            <Text variant="sectionCount">{project.unchecked}</Text>
            <Icon color="dim" name="chevron-right" size={17} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

function ProjectMark({ mark }: { mark: HomeProject["mark"] }) {
  if (mark === undefined) return null;
  if (mark === "running") return <Spinner size={15} />;
  if (mark === "needs-you") return <StatusMark compact state="blocked" />;
  return <View className="h-2 w-2 rounded-full bg-done" style={{ borderWidth: HAIRLINE }} />;
}
