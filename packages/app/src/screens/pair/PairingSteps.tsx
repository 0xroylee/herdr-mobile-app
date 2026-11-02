import type { ReactNode } from "react";
import { View } from "react-native";
import type { ConnectionState } from "../../store/core.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Text } from "../../ui/text.tsx";
import { ConnectionLine } from "./ConnectionLine.tsx";
import type { PairedDevice } from "./pairing.ts";
import { Snippet } from "./Snippet.tsx";

export function PairingSteps({
  connectionState,
  paired,
}: {
  connectionState?: ConnectionState;
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
      <Step number="3" title="Keep Tailscale on">
        {paired ? (
          <ConnectionLine
            connectionState={connectionState}
            deviceName={paired.deviceName}
            machineName={paired.machineName}
          />
        ) : (
          <Text variant="callout">Your phone connects through your tailnet.</Text>
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
