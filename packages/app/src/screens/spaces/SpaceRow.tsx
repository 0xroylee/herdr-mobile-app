import { Pressable, View } from "react-native";
import type { SpaceRow as SpaceData } from "@/model/spaces.ts";
import { StatusMark } from "@/ui/components/StatusMark.tsx";
import { Icon } from "@/ui/icon.tsx";
import { Text } from "@/ui/text.tsx";
import { TabPill } from "./TabPill.tsx";

const rowClasses = {
  rest: "min-h-[54px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[54px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export interface SpaceRowProps {
  space: SpaceData;
  expanded: boolean;
  canCreateTab: boolean;
  isCreating: boolean;
  onToggle(): void;
  onNewTab(): void;
  onOpenTerminal(address: string): void;
}

export function SpaceRow({
  space,
  expanded,
  canCreateTab,
  isCreating,
  onToggle,
  onNewTab,
  onOpenTerminal,
}: SpaceRowProps) {
  const isIdle = space.state === "idle";

  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onToggle}>
        {({ pressed }) => (
          <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
            <View className="min-w-0 flex-1">
              <Text
                numberOfLines={1}
                style={isIdle ? { fontFamily: "Geist_400Regular" } : undefined}
                tone={isIdle ? "muted" : "fg"}
                variant="headline"
              >
                {space.name}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <StatusMark compact={space.state === "blocked"} state={space.state} />
              <Icon color="dim" name={expanded ? "chevron-down" : "chevron-right"} size={17} />
            </View>
          </View>
        )}
      </Pressable>

      {expanded ? (
        <View className="flex-row flex-wrap gap-1.5 px-3.5 pb-3.5">
          {space.tabs.map((tab) => (
            <TabPill key={tab.id} onOpenTerminal={onOpenTerminal} tab={tab} />
          ))}
          {canCreateTab ? <TabPill add disabled={isCreating} onPress={onNewTab} /> : null}
        </View>
      ) : null}
    </View>
  );
}
