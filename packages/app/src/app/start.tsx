import { useLocalSearchParams } from "expo-router";
import { StartScreen } from "../screens/start/StartScreen.tsx";

export default function StartRoute() {
  const params = useLocalSearchParams<{ space?: string | string[] }>();
  const preselectedSpaceTargetId = Array.isArray(params.space) ? params.space[0] : params.space;

  return <StartScreen preselectedSpaceTargetId={preselectedSpaceTargetId} />;
}
