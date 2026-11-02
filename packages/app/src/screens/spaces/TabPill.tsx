import { Pressable, View } from "react-native";
import { getProgram } from "@/model/program.ts";
import type { SpaceTabRow } from "@/model/spaces.ts";
import { ProgramIcon } from "@/ui/components/ProgramIcon.tsx";
import { Icon } from "@/ui/icon.tsx";
import { Text } from "@/ui/text.tsx";
import { firstTerminalAddress, tabDotState, tabPillHitSlop } from "./viewState.ts";

export interface TabPillProps {
  tab?: SpaceTabRow;
  add?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onOpenTerminal?: (address: string) => void;
}

const dotClasses = {
  blocked: "h-1.5 w-1.5 rounded-full bg-blocked",
  done: "h-1.5 w-1.5 rounded-full bg-done",
} as const;

export function TabPill({
  tab,
  add = false,
  disabled = false,
  onPress,
  onOpenTerminal,
}: TabPillProps) {
  if (add) {
    return (
      <Pressable
        accessibilityLabel="New tab"
        accessibilityRole="button"
        disabled={disabled}
        hitSlop={tabPillHitSlop}
        onPress={onPress}
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        {({ pressed }) => (
          <View
            className="h-[30px] flex-row items-center justify-center rounded-md bg-raised px-[9px]"
            style={{ opacity: pressed ? 0.85 : 1 }}
          >
            <Icon color="dim" name="plus" size={15} />
          </View>
        )}
      </Pressable>
    );
  }

  if (tab === undefined) return null;

  const firstTerminal = tab.terminals[0];
  const firstAddress = firstTerminalAddress(tab.terminals);
  const dotState = tabDotState(tab.state);
  const dotClass = dotState === undefined ? undefined : dotClasses[dotState];

  return (
    <Pressable
      accessibilityRole="button"
      disabled={firstAddress === undefined}
      hitSlop={tabPillHitSlop}
      onPress={() => {
        if (firstAddress !== undefined) onOpenTerminal?.(firstAddress);
      }}
    >
      {({ pressed }) => (
        <View
          className="h-[30px] max-w-full flex-row items-center gap-1.75 rounded-md bg-raised px-[11px]"
          style={{ opacity: pressed ? 0.85 : 1 }}
        >
          {firstTerminal ? (
            <ProgramIcon program={getProgram(firstTerminal).name} size="tab" />
          ) : null}
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} tone="fg" variant="sectionCount">
              {tab.name}
            </Text>
          </View>
          {dotClass ? <View className={dotClass} /> : null}
        </View>
      )}
    </Pressable>
  );
}
