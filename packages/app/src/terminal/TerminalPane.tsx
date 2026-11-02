import { View } from "react-native";
import { useUniwind } from "uniwind";
import { HAIRLINE } from "../ui/components/classes.ts";
import { ProgramIcon } from "../ui/components/ProgramIcon.tsx";
import { Text } from "../ui/text.tsx";
import { shortenHomeFolder } from "./folder.ts";
import { type TerminalTheme, terminalPalettes } from "./palette.ts";
import type { ScreenSnapshot } from "./snapshot.ts";
import { TerminalGrid } from "./TerminalGrid.tsx";

export interface TerminalPaneProps {
  program: string;
  folder: string;
  homeDirectory?: string;
  snapshot: ScreenSnapshot;
}

export function TerminalPane({ program, folder, homeDirectory, snapshot }: TerminalPaneProps) {
  const { theme } = useUniwind();
  const paletteTheme: TerminalTheme = theme === "dark" ? "graphite" : "paper";
  const palette = terminalPalettes[paletteTheme];

  return (
    <View
      className="flex-1 overflow-hidden rounded-pane border-border bg-term-bg"
      style={{ borderWidth: HAIRLINE }}
    >
      <View className="h-[34px] flex-row items-center gap-2 px-3">
        <ProgramIcon program={program} size="pane" />
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Text numberOfLines={1} variant="captionMedium">
            {program}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {shortenHomeFolder(folder, homeDirectory)}
          </Text>
        </View>
        <Text variant="terminalSize">
          {snapshot.cols}×{snapshot.rows.length}
        </Text>
      </View>
      <View className="bg-border" style={{ height: HAIRLINE }} />
      <TerminalGrid palette={palette} snapshot={snapshot} />
    </View>
  );
}
