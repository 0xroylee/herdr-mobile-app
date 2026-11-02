// @ts-expect-error Metro processes this global stylesheet import.
import "../global.css";

import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Boot } from "../boot.tsx";
import { useAppFonts } from "../ui/fonts.ts";
import { AppSafeArea } from "../ui/safe-area.tsx";
import { applyTheme } from "../ui/theme.ts";

applyTheme("system");
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontAttempt, setFontAttempt] = useState(0);

  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <FontGate
        key={fontAttempt}
        retrying={fontAttempt > 0}
        onRetry={() => setFontAttempt((attempt) => attempt + 1)}
      />
    </SafeAreaProvider>
  );
}

function FontGate({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const [fontsLoaded, error] = useAppFonts();

  useEffect(() => {
    if (fontsLoaded || error) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, error]);

  if (error) return <FontLoadError onRetry={onRetry} />;

  if (!fontsLoaded) {
    return retrying ? <View className="flex-1 bg-canvas" /> : null;
  }

  return (
    <AppSafeArea>
      <Boot />
      <Stack screenOptions={{ headerShown: false }} />
    </AppSafeArea>
  );
}

function FontLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center bg-canvas px-6">
      <Text className="text-fg">Couldn’t load the app fonts.</Text>
      <Pressable
        accessibilityRole="button"
        className="mt-3 min-h-11 min-w-11 items-center justify-center px-4"
        onPress={onRetry}
      >
        <Text className="text-fg">Retry</Text>
      </Pressable>
    </View>
  );
}
