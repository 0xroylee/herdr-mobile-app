import { Activity } from "lucide-react-native";
import { View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { type HomeTile, homeTileGlyph, homeTileIconBackground } from "./home-view.ts";

export function SmartTiles({ tiles }: { tiles: readonly HomeTile[] }) {
  const needsYou = tiles.find((tile) => tile.kind === "needs-you");
  const running = tiles.find((tile) => tile.kind === "running");
  const done = tiles.find((tile) => tile.kind === "done");

  return (
    <View className="gap-2.5">
      <View className="flex-row gap-2.5">
        {needsYou ? <Tile tile={needsYou} /> : null}
        {running ? <Tile tile={running} /> : null}
      </View>
      <View className="flex-row gap-2.5">
        {done ? <Tile tile={done} /> : null}
        <View className="flex-1" />
      </View>
    </View>
  );
}

function Tile({ tile }: { tile: HomeTile }) {
  const glyph = homeTileGlyph(tile.kind);
  return (
    <View
      className="min-h-[106px] flex-1 justify-between rounded-card border-border bg-surface p-3"
      style={{ borderWidth: HAIRLINE }}
    >
      <View className="flex-row items-center justify-between">
        <View
          className={`h-[30px] w-[30px] items-center justify-center rounded-full ${homeTileIconBackground(tile.kind)}`}
        >
          {glyph === "!" ? (
            <Text variant="title" tone="solid-fg">
              !
            </Text>
          ) : glyph === "activity" ? (
            <Activity color="white" size={17} strokeWidth={2.4} />
          ) : (
            <Icon color="solid-fg" name="check" size={19} />
          )}
        </View>
        <Text variant="pairTitle" tone="fg">
          {tile.count}
        </Text>
      </View>
      <Text variant="headline" tone="muted">
        {tile.label}
      </Text>
    </View>
  );
}
