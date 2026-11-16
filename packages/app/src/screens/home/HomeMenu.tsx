import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";

const itemClasses = {
  rest: "min-h-12 justify-center rounded-btn px-3",
  pressed: "min-h-12 justify-center rounded-btn bg-raised px-3",
} as const;

export function HomeMenu({ onSettings, onPairAgain }: { onSettings(): void; onPairAgain(): void }) {
  const [open, setOpen] = useState(false);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <>
      <IconButton
        accessibilityLabel="More options"
        icon="ellipsis"
        onPress={() => setOpen(true)}
        variant="boxed"
      />
      <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
        <View className="flex-1 justify-end bg-black/30">
          <Pressable
            accessibilityLabel="Close menu"
            className="absolute inset-0"
            onPress={() => setOpen(false)}
          />
          <View
            className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
            style={{ borderWidth: HAIRLINE }}
          >
            {[
              { label: "Settings", action: onSettings },
              { label: "Pair again", action: onPairAgain },
            ].map(({ label, action }) => (
              <Pressable accessibilityRole="button" key={label} onPress={() => choose(action)}>
                {({ pressed }) => (
                  <View className={pressed ? itemClasses.pressed : itemClasses.rest}>
                    <Text variant="button">{label}</Text>
                  </View>
                )}
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
              {({ pressed }) => (
                <View
                  className={`mt-2 min-h-11 items-center justify-center rounded-btn ${pressed ? "bg-raised" : "bg-surface"}`}
                >
                  <Text variant="button" tone="muted">
                    Cancel
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
