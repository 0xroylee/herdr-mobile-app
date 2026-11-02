import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { ScreenHeader } from "../../ui/components/ScreenHeader.tsx";
import { Text } from "../../ui/text.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { MachinesSection } from "./MachinesSection.tsx";
import { NotificationsRows } from "./NotificationsRows.tsx";
import { ThemeRow } from "./ThemeRow.tsx";

export function SettingsScreen() {
  return (
    <ScrollView className="flex-1 bg-canvas">
      <View className="gap-5 px-3.5 pb-8 pt-safe">
        <ScreenHeader title="Settings" />
        <SettingsSection title="Appearance">
          <ThemeRow />
        </SettingsSection>
        <SettingsSection title="Notifications">
          <NotificationsRows />
        </SettingsSection>
        <SettingsSection title="Machines">
          <MachinesSection />
        </SettingsSection>
        <SettingsSection title="About">
          <AboutSection />
        </SettingsSection>
      </View>
    </ScrollView>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <View className="px-1">
        <Text variant="section">{title}</Text>
      </View>
      {children}
    </View>
  );
}
