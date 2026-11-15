import { type Href, useRouter } from "expo-router";
import { View } from "react-native";
import { useConnectionManager } from "../../boot.tsx";
import { Banner } from "../../ui/components/Banner.tsx";
import type { ConnectionPresentation } from "./connectionPresentation.ts";
import { PairAgainBanner } from "./PairAgainBanner.tsx";

export function ConnectionBanner({ presentation }: { presentation: ConnectionPresentation }) {
  const router = useRouter();
  const manager = useConnectionManager();
  const banner = presentation.banner;
  if (banner === undefined) return null;

  return (
    <View className="pb-2.5">
      {banner.kind === "unauthorized" ? (
        <PairAgainBanner message={banner.message} onPair={() => router.push("/pair" as Href)} />
      ) : (
        <Banner
          message={banner.message}
          onRetry={banner.action === "retry" ? () => manager?.start() : undefined}
          state={banner.kind}
        />
      )}
    </View>
  );
}
