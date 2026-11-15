import { type Href, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { routes } from "../../routes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { MachinesSection } from "./MachinesSection.tsx";
import { NotificationsRows } from "./NotificationsRows.tsx";
import { ThemeRow } from "./ThemeRow.tsx";

export function SettingsScreen() {
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-canvas">
      <View className="gap-5 px-3.5 pb-8 pt-safe">
        <View className="flex-row items-center gap-2">
          <IconButton
            accessibilityLabel="Back"
            icon="chevron-left"
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace(routes.home as Href);
            }}
            size="back"
          />
          <Text variant="largeTitle">Settings</Text>
        </View>
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
