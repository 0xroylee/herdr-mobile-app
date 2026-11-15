import { ScrollView } from "react-native";
import type { SpaceTabRow } from "../../model/spaces.ts";
import { TabPill } from "./TabPill.tsx";
import { terminalsListContentClassName, terminalsListScrollClassName } from "./viewState.ts";

export function TerminalsList({
  tabs,
  onOpenTerminal,
}: {
  tabs: readonly SpaceTabRow[];
  onOpenTerminal(address: string): void;
}) {
  return (
    <ScrollView
      className={terminalsListScrollClassName}
      contentContainerClassName={terminalsListContentClassName}
      showsVerticalScrollIndicator={false}
    >
      {tabs.map((tab) => (
        <TabPill key={tab.id} onOpenTerminal={onOpenTerminal} tab={tab} />
      ))}
    </ScrollView>
  );
}
