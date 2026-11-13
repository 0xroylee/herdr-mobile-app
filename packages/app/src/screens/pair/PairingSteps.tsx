import type { ReactNode } from "react";
import { View } from "react-native";
import type { ConnectionState } from "../../store/core.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Text } from "../../ui/text.tsx";
import { ConnectionLine } from "./ConnectionLine.tsx";
import { connectionLineState } from "./connection-line-state.ts";
import type { PairedDevice } from "./pairing.ts";
import { Snippet } from "./Snippet.tsx";

export function PairingSteps({
  connectionState,
  connectionRoute,
  paired,
}: {
  connectionState?: ConnectionState;
  connectionRoute?: "direct" | "secure";
  paired?: PairedDevice;
}) {
  return (
    <ListGroup>
      <Step number="1" title="Start the bridge on your Mac">
        <Snippet />
      </Step>
      <Step number="2" title="Scan the code it shows">
        <Text variant="callout">It holds the bridge address and a one-time pairing code.</Text>
      </Step>
      <Step number="3" title="Keep Tailscale on, or set up the secure route.">
        {paired ? (
          connectionState === "connected" && connectionRoute ? (
            <View className="flex-row items-center gap-2 pt-1">
              <View className="h-2 w-2 rounded-full bg-done" />
              <Text variant="subhead" tone="done">
                {
                  connectionLineState(
                    "connected",
                    paired.machineName,
                    paired.deviceName,
                    connectionRoute,
                  ).message
                }
              </Text>
            </View>
          ) : (
            <ConnectionLine
              connectionState={connectionState}
              deviceName={paired.deviceName}
              machineName={paired.machineName}
            />
          )
        ) : (
          <Text variant="callout">Your phone connects over Tailscale or the secure route.</Text>
        )}
      </Step>
    </ListGroup>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <View className="flex-row items-start gap-3.5 px-3.5 py-3">
      <View className="h-6 w-6 items-center justify-center rounded-full bg-raised">
        <Text style={{ fontSize: 12.5, lineHeight: 15 }} variant="micro" tone="muted">
          {number}
        </Text>
      </View>
      <View className="min-w-0 flex-1 gap-2 pt-0.5">
        <Text variant="body">{title}</Text>
        {children}
      </View>
    </View>
  );
}
