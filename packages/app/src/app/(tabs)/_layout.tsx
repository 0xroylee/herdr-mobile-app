import { Tabs } from "expo-router";
import { StyleSheet, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { Icon } from "@/ui/icon.tsx";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const tabBarHeight = Math.ceil(49 + 13 * (Math.max(1, fontScale) - 1)) + insets.bottom;
  const [chrome, fg, dim, border] = useCSSVariable([
    "--color-chrome",
    "--color-fg",
    "--color-dim",
    "--color-border",
  ] as const);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: String(fg),
        tabBarInactiveTintColor: String(dim),
        tabBarLabelPosition: "below-icon",
        tabBarAllowFontScaling: true,
        tabBarIconStyle: {
          height: 23,
        },
        tabBarStyle: {
          height: tabBarHeight,
          paddingBottom: insets.bottom,
          backgroundColor: String(chrome),
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          borderTopColor: String(border),
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabelStyle: {
          fontFamily: "Geist_500Medium",
          fontSize: 10.5,
          lineHeight: 13,
          marginTop: 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Agents",
          tabBarIcon: ({ focused }) => (
            <Icon name="bot" size="tab" color={focused ? "fg" : "dim"} />
          ),
        }}
      />
      <Tabs.Screen
        name="spaces"
        options={{
          title: "Spaces",
          tabBarIcon: ({ focused }) => (
            <Icon name="layers" size="tab" color={focused ? "fg" : "dim"} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => (
            <Icon name="settings" size="tab" color={focused ? "fg" : "dim"} />
          ),
        }}
      />
    </Tabs>
  );
}
