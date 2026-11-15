import { View } from "react-native";
import type { SpaceTabRow } from "../../model/spaces.ts";
import { TabPill } from "./TabPill.tsx";

export function TerminalsList({
  tabs,
  onOpenTerminal,
}: {
  tabs: readonly SpaceTabRow[];
  onOpenTerminal(address: string): void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {tabs.map((tab) => (
        <TabPill key={tab.id} onOpenTerminal={onOpenTerminal} tab={tab} />
      ))}
    </View>
  );
}
