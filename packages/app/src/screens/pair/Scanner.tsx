import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Modal, View } from "react-native";
import { withUniwind } from "uniwind";
import type { PairInput } from "../../net/pair-link.ts";
import { Button } from "../../ui/components/Button.tsx";
import { Text } from "../../ui/text.tsx";
import { createScannerController } from "./scanner-controller.ts";

const CLOSE_LABEL = "Close";
const ALLOW_CAMERA_LABEL = "Allow camera";
const UniwindCameraView = withUniwind(CameraView);

export interface ScannerProps {
  visible: boolean;
  onScan(input: PairInput): void;
  onClose(): void;
}

export function Scanner({ visible, onScan, onClose }: ScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const controller = useMemo(() => createScannerController(), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (!visible) controller.reset();
  }, [controller, visible]);

  const handleScan = (result: BarcodeScanningResult) => {
    const input = controller.scan(result.data);
    if (input) onScan(input);
  };

  const close = () => {
    controller.reset();
    onClose();
  };

  return (
    <Modal animationType="slide" onRequestClose={close} visible={visible}>
      <View className="flex-1 bg-canvas px-3.5 pb-safe pt-safe">
        <View className="flex-row items-center justify-between py-3">
          <Text variant="headline">Scan pairing code</Text>
          <Button onPress={close} variant="outline">
            {CLOSE_LABEL}
          </Button>
        </View>
        {permission?.granted ? (
          <View className="min-h-0 flex-1 overflow-hidden rounded-card border-border bg-surface">
            <UniwindCameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              className="flex-1"
              onBarcodeScanned={handleScan}
            />
          </View>
        ) : (
          <View className="flex-1 items-center justify-center gap-4 px-4">
            <Text variant="body" style={{ textAlign: "center" }}>
              Allow camera access to scan the QR code from your Mac.
            </Text>
            {permission?.canAskAgain === false ? (
              <Text variant="callout" style={{ textAlign: "center" }}>
                Camera access is disabled. You can enter the address and code instead.
              </Text>
            ) : (
              <Button onPress={() => void requestPermission()} variant="large">
                {ALLOW_CAMERA_LABEL}
              </Button>
            )}
          </View>
        )}
        {state.message ? (
          <View className="py-3">
            <Text variant="callout" tone="danger">
              {state.message}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
