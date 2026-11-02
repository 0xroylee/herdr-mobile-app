import { useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionState } from "../../store/core.ts";
import type { Machine } from "../../store/machines.ts";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";

const connectionDotClasses: Record<ConnectionState, string> = {
  connecting: "h-2 w-2 shrink-0 rounded-full bg-working",
  connected: "h-2 w-2 shrink-0 rounded-full bg-done",
  reconnecting: "h-2 w-2 shrink-0 rounded-full bg-blocked",
  offline: "h-2 w-2 shrink-0 rounded-full bg-dim",
  unauthorized: "h-2 w-2 shrink-0 rounded-full bg-blocked",
};

const chipClasses = {
  rest: "min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-full border-border bg-surface px-3",
  pressed:
    "min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-full border-border bg-raised px-3",
} as const;

const machineRowClasses = {
  rest: "min-h-12 flex-row items-center gap-3 rounded-btn bg-surface px-2",
  pressed: "min-h-12 flex-row items-center gap-3 rounded-btn bg-raised px-2",
} as const;

const cancelClasses = {
  rest: "mt-2 min-h-11 items-center justify-center rounded-btn bg-surface",
  pressed: "mt-2 min-h-11 items-center justify-center rounded-btn bg-raised",
} as const;

export interface MachineChipProps {
  machines: readonly Machine[];
  activeId: string | null;
  connections: Readonly<Record<string, ConnectionState | undefined>>;
  agentCount: number;
  spaceCount: number;
  onSelect(id: string): void;
}

export function MachineChip({
  machines,
  activeId,
  connections,
  agentCount,
  spaceCount,
  onSelect,
}: MachineChipProps) {
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const availableSheetHeight = Math.max(0, height - insets.top - insets.bottom - 24);
  const availableMachineListHeight = Math.max(0, availableSheetHeight - 100);
  const activeMachine = machines.find((machine) => machine.id === activeId);

  return (
    <View className="flex-row items-center gap-2">
      <Pressable
        accessibilityLabel="Choose paired machine"
        accessibilityRole="button"
        onPress={() => setOpen(true)}
      >
        {({ pressed }) => (
          <View
            className={pressed ? chipClasses.pressed : chipClasses.rest}
            style={{ borderWidth: HAIRLINE }}
          >
            <View className={connectionDotClasses[connections[activeId ?? ""] ?? "offline"]} />
            <Text numberOfLines={1} variant="button" tone="fg">
              {activeMachine?.name ?? "Choose a Mac"}
            </Text>
            <Icon color="dim" name="chevron-down" size={14} />
          </View>
        )}
      </Pressable>
      <Text numberOfLines={1} variant="subhead" tone="dim">
        {agentCount} agents · {spaceCount} spaces
      </Text>

      <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
        <View className="flex-1 justify-end bg-black/30">
          <Pressable
            accessibilityLabel="Close machine list"
            className="absolute inset-0"
            onPress={() => setOpen(false)}
          />
          <View
            className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
            style={{ borderWidth: HAIRLINE, maxHeight: availableSheetHeight }}
          >
            <View className="pb-2">
              <Text variant="title">Paired machines</Text>
            </View>
            {machines.length > 0 ? (
              <ScrollView
                className="min-h-0 flex-1"
                showsVerticalScrollIndicator={false}
                style={{ maxHeight: availableMachineListHeight }}
              >
                {machines.map((machine) => {
                  const connection = connections[machine.id] ?? "offline";
                  return (
                    <Pressable
                      accessibilityLabel={`${machine.name}, ${machine.role === "watch" ? "watch" : "control"}${machine.id === activeId ? ", active" : ""}`}
                      accessibilityRole="button"
                      key={machine.id}
                      onPress={() => {
                        setOpen(false);
                        onSelect(machine.id);
                      }}
                    >
                      {({ pressed }) => (
                        <View
                          className={pressed ? machineRowClasses.pressed : machineRowClasses.rest}
                        >
                          <View className={connectionDotClasses[connection]} />
                          <View className="min-w-0 flex-1">
                            <Text numberOfLines={1} variant="headline">
                              {machine.name}
                            </Text>
                            <Text variant="caption">
                              {machine.role === "watch" ? "Watch" : "Control"}
                            </Text>
                          </View>
                          {machine.id === activeId ? (
                            <Text variant="captionMedium">Active</Text>
                          ) : null}
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <View className="py-3">
                <Text variant="callout">No paired machines yet.</Text>
              </View>
            )}
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
              {({ pressed }) => (
                <View className={pressed ? cancelClasses.pressed : cancelClasses.rest}>
                  <Text variant="button">Cancel</Text>
                </View>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}
