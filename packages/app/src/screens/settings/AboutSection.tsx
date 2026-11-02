import { BRIDGE_PROTOCOL_VERSION } from "@herdr-mobile/protocol";
import Constants from "expo-constants";
import { View } from "react-native";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Text } from "../../ui/text.tsx";

export function AboutSection() {
  const version = Constants.expoConfig?.version ?? "Unknown";

  return (
    <ListGroup>
      <Row label="App version" value={version} />
      <Row label="Bridge protocol" value={String(BRIDGE_PROTOCOL_VERSION)} />
      <View className="px-3.5 py-3">
        <Text variant="callout">
          On web, your device token stays in this browser's storage. Use the web client only on your
          tailnet.
        </Text>
      </View>
    </ListGroup>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-h-[48px] flex-row items-center justify-between gap-3 px-3.5 py-2">
      <Text variant="body">{label}</Text>
      <Text variant="subhead">{value}</Text>
    </View>
  );
}
