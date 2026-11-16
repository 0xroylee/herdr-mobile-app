import { Activity } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import { type HomeTile, homeTileGlyph, homeTileIconBackground } from "./home-view.ts";

export function SmartTiles({
  tiles,
  onOpen,
}: {
  tiles: readonly HomeTile[];
  onOpen(kind: HomeTile["kind"]): void;
}) {
  const needsYou = tiles.find((tile) => tile.kind === "needs-you");
  const running = tiles.find((tile) => tile.kind === "running");
  const done = tiles.find((tile) => tile.kind === "done");

  return (
    <View className="gap-2.5">
      <View className="flex-row gap-2.5">
        {needsYou ? <Tile onPress={() => onOpen(needsYou.kind)} tile={needsYou} /> : null}
        {running ? <Tile onPress={() => onOpen(running.kind)} tile={running} /> : null}
      </View>
      <View className="flex-row gap-2.5">
        {done ? <Tile onPress={() => onOpen(done.kind)} tile={done} /> : null}
        <View className="flex-1" />
      </View>
    </View>
  );
}

function Tile({ tile, onPress }: { tile: HomeTile; onPress(): void }) {
  const glyph = homeTileGlyph(tile.kind);
  return (
    <Pressable
      accessibilityLabel={`${tile.label}, ${tile.count}`}
      accessibilityRole="button"
      className="min-h-[106px] flex-1 rounded-card border-border bg-surface p-3"
      onPress={onPress}
      style={({ pressed }) => ({ borderWidth: HAIRLINE, opacity: pressed ? 0.82 : 1 })}
    >
      <View className="flex-1 justify-between">
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
    </Pressable>
  );
}
