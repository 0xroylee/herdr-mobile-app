import { View } from "react-native";
import type { ConnectionState } from "../../store/core.ts";
import { Text } from "../../ui/text.tsx";
import { connectionLineState } from "./connection-line-state.ts";

const indicatorClasses = {
  done: "h-2 w-2 rounded-full bg-done",
  working: "h-2 w-2 rounded-full bg-working",
  blocked: "h-2 w-2 rounded-full bg-blocked",
} as const;

export function ConnectionLine({
  connectionState,
  deviceName,
  machineName,
}: {
  connectionState?: ConnectionState;
  deviceName: string;
  machineName: string;
}) {
  const status = connectionLineState(connectionState, machineName, deviceName);

  return (
    <View className="flex-row items-center gap-2 pt-1">
      <View className={indicatorClasses[status.indicator]} />
      <Text variant="subhead" tone={status.tone}>
        {status.message}
      </Text>
    </View>
  );
}
