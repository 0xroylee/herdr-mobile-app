import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useConnectionManager } from "../../boot.tsx";
import { createBridgeApi } from "../../net/bridge-api.ts";
import { routes } from "../../routes.ts";
import { appSecrets, machinesStore } from "../../store/platform.ts";
import { Banner } from "../../ui/components/Banner.tsx";
import { Button } from "../../ui/components/Button.tsx";
import { Text } from "../../ui/text.tsx";
import { ManualEntry } from "./ManualEntry.tsx";
import { PairingSteps } from "./PairingSteps.tsx";
import { PairingController } from "./pair-controller.ts";
import { pairingDeviceName } from "./pairing.ts";
import { Scanner } from "./Scanner.tsx";

const bridgeApi = createBridgeApi((input, init) => globalThis.fetch(input, init));
const deviceName = pairingDeviceName(Device.deviceName, Platform.OS === "web");

const textActionClasses = {
  rest: "min-h-11 items-center justify-center rounded-btn px-3",
  pressed: "min-h-11 items-center justify-center rounded-btn bg-raised px-3",
} as const;

export function PairScreen() {
  const router = useRouter();
  const manager = useConnectionManager();
  const controller = useMemo(
    () => new PairingController(bridgeApi, appSecrets, machinesStore, deviceName),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.setConnectionManager(manager);
    return () => controller.setConnectionManager(undefined);
  }, [controller, manager]);

  useEffect(() => controller.consumeCapturedPairFragment(), [controller]);

  // Pop back to the tabs when /pair was pushed over them, or replace /pair on first launch.
  useEffect(() => {
    if (state.paired) router.dismissTo(routes.agents);
  }, [router, state.paired]);

  return (
    <ScrollView className="flex-1 bg-canvas" keyboardShouldPersistTaps="handled">
      <View className="gap-5 px-3.5 pb-8 pt-safe">
        <View className="gap-2 pt-3">
          <Text variant="pairTitle">Connect to your Mac</Text>
          <Text variant="body" tone="muted">
            Reach the bridge through Tailscale. Your terminals stay on your tailnet.
          </Text>
        </View>

        {state.banner ? (
          <Banner
            message={state.banner}
            onRetry={state.retryable ? controller.retry : undefined}
            state="offline"
          />
        ) : null}

        <PairingSteps connectionState={state.connectionState} paired={state.paired} />

        {state.paired ? (
          <Text variant="callout">Paired with {state.paired.machineName}. Opening agents…</Text>
        ) : state.manual ? (
          <ManualEntry
            address={state.address}
            busy={state.busy}
            code={state.code}
            onAddressChange={controller.setAddress}
            onCancel={controller.hideManualEntry}
            onCodeChange={controller.setCode}
            onPair={controller.submitManual}
          />
        ) : (
          <View className="gap-2">
            <Button
              disabled={state.busy}
              icon="scan-line"
              onPress={controller.showScanner}
              variant="large"
            >
              {state.busy ? "Pairing…" : "Scan the code"}
            </Button>
            <Pressable accessibilityRole="button" onPress={controller.showManualEntry}>
              {({ pressed }) => (
                <View className={textActionClasses[pressed ? "pressed" : "rest"]}>
                  <Text variant="button" tone="muted">
                    Type the address instead
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        )}
      </View>
      <Scanner
        onClose={controller.closeScanner}
        onScan={controller.acceptScan}
        visible={state.scannerVisible}
      />
    </ScrollView>
  );
}
