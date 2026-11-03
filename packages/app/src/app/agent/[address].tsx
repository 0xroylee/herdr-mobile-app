import type { StartAgentPlacement } from "@herdr-mobile/protocol";
import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "../../screens/agent/AgentScreen.tsx";

export default function AgentRoute() {
  const params = useLocalSearchParams<{
    address?: string | string[];
    started?: string | string[];
    takeover?: string;
  }>();
  const address = Array.isArray(params.address)
    ? (params.address[0] ?? "")
    : (params.address ?? "");
  const startedValue = Array.isArray(params.started) ? params.started[0] : params.started;
  const startedPlacement: StartAgentPlacement | undefined =
    startedValue === "core" || startedValue === "window" ? startedValue : undefined;

  return (
    <AgentScreen
      address={address}
      requestTakeover={params.takeover === "1"}
      startedPlacement={startedPlacement}
    />
  );
}
