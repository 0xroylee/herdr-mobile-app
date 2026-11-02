import type { ReactNode } from "react";
import { SafeAreaListener } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

export function AppSafeArea({ children }: { children: ReactNode }) {
  return (
    <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)} style={{ flex: 1 }}>
      {children}
    </SafeAreaListener>
  );
}
