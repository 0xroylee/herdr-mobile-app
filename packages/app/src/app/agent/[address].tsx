import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "../../screens/agent/AgentScreen.tsx";

export default function AgentRoute() {
  const params = useLocalSearchParams<{ address?: string | string[]; takeover?: string }>();
  const address = Array.isArray(params.address)
    ? (params.address[0] ?? "")
    : (params.address ?? "");

  return <AgentScreen address={address} requestTakeover={params.takeover === "1"} />;
}
