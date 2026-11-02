import { Pressable, View } from "react-native";
import { settingsStore } from "../../store/platform.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Text } from "../../ui/text.tsx";

export function NotificationsRows() {
  const blocked = settingsStore((state) => state.notify.blocked);
  const done = settingsStore((state) => state.notify.done);

  return (
    <ListGroup>
      <NotificationToggle
        description="When an agent needs your attention"
        enabled={blocked}
        label="Needs you"
        onChange={() => settingsStore.getState().setNotifyBlocked(!blocked)}
      />
      <NotificationToggle
        description="When an agent finishes a task"
        enabled={done}
        label="Done"
        onChange={() => settingsStore.getState().setNotifyDone(!done)}
      />
    </ListGroup>
  );
}

const toggleTrackClasses = {
  on: "h-[26px] w-11 justify-center rounded-full bg-solid",
  off: "h-[26px] w-11 justify-center rounded-full bg-raised",
} as const;

const toggleThumbClasses = {
  on: "h-[18px] w-[18px] rounded-full bg-solid-fg",
  off: "h-[18px] w-[18px] rounded-full bg-muted",
} as const;

function NotificationToggle({
  description,
  enabled,
  label,
  onChange,
}: {
  description: string;
  enabled: boolean;
  label: string;
  onChange(): void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      onPress={onChange}
    >
      {({ pressed }) => (
        <View
          className={
            pressed
              ? "min-h-[58px] flex-row items-center justify-between gap-3 bg-raised px-3.5 py-2.5"
              : "min-h-[58px] flex-row items-center justify-between gap-3 px-3.5 py-2.5"
          }
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text variant="headline">{label}</Text>
            <Text variant="subhead">{description}</Text>
          </View>
          <View className={toggleTrackClasses[enabled ? "on" : "off"]}>
            <View
              className={toggleThumbClasses[enabled ? "on" : "off"]}
              style={{ transform: [{ translateX: enabled ? 22 : 4 }] }}
            />
          </View>
        </View>
      )}
    </Pressable>
  );
}
