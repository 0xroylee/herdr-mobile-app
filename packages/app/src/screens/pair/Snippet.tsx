import * as Clipboard from "expo-clipboard";
import { useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";
import { createSnippetController, PAIR_COMMAND } from "./snippet-controller.ts";

export function Snippet() {
  const controller = useMemo(() => createSnippetController(Clipboard), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return (
    <View
      className="min-h-11 flex-row items-center justify-between gap-2 rounded-key border-border bg-term-bg px-[11px] py-[9px]"
      style={{ borderWidth: HAIRLINE }}
    >
      <Text numberOfLines={1} selectable style={{ fontSize: 12, lineHeight: 16 }} variant="mono">
        {PAIR_COMMAND}
      </Text>
      <View className="flex-row items-center gap-1">
        {state.copied ? (
          <Text variant="caption" tone="done">
            Copied
          </Text>
        ) : state.failed ? (
          <Text variant="caption" tone="danger">
            Copy failed
          </Text>
        ) : null}
        <IconButton
          accessibilityLabel="Copy herdr-bridge pair"
          icon="copy"
          onPress={() => void controller.copy()}
          size={17}
        />
      </View>
    </View>
  );
}
