import type { ViewStyle } from "react-native";

export type TerminalScrollStyle = ViewStyle & {
  overflowAnchor?: "none";
};

export function terminalScrollStyle(platform: string): TerminalScrollStyle | undefined {
  return platform === "web" ? { overflowAnchor: "none" } : undefined;
}
