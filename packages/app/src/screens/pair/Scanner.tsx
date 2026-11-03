import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, useWindowDimensions, View } from "react-native";
import { withUniwind } from "uniwind";
import type { PairInput } from "../../net/pair-link.ts";
import { Button } from "../../ui/components/Button.tsx";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";
import { createScannerController } from "./scanner-controller.ts";

const CLOSE_LABEL = "Close";
const ALLOW_CAMERA_LABEL = "Allow camera";
const WEB_CARD_MAX_HEIGHT = 640;
const WEB_CARD_MARGIN = 14;
const UniwindCameraView = withUniwind(CameraView);
const isIos = Platform.OS === "ios";
const isWeb = Platform.OS === "web";

// An iOS page sheet starts below the status bar, so only the bottom inset applies there.
const frameClasses = {
  sheet: "flex-1 bg-canvas px-3.5 pb-safe",
  fullScreen: "flex-1 bg-canvas px-3.5 pb-safe pt-safe",
} as const;

export interface ScannerProps {
  visible: boolean;
  onScan(input: PairInput): void;
  onClose(): void;
}

/** A modal sheet on iOS, a full-screen modal on Android, and a centered card on web. */
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
    <Modal
      allowSwipeDismissal={isIos}
      animationType={isWeb ? "fade" : "slide"}
      onRequestClose={close}
      presentationStyle={isIos ? "pageSheet" : undefined}
      transparent={isWeb}
      visible={visible}
    >
      <ScannerFrame onClose={close}>
        <View className="min-h-[50px] flex-row items-center">
          <IconButton accessibilityLabel={CLOSE_LABEL} icon="x" onPress={close} />
          <View className="min-w-0 flex-1 items-center">
            <Text numberOfLines={1} variant="headline">
              Scan pairing code
            </Text>
          </View>
          <View className="w-11" />
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
      </ScannerFrame>
    </Modal>
  );
}

function ScannerFrame({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const { height } = useWindowDimensions();

  if (isWeb) {
    return (
      <View className="flex-1 items-center justify-center bg-black/30 p-3.5">
        <Pressable
          accessibilityLabel="Close scanner"
          className="absolute inset-0"
          onPress={onClose}
        />
        <View
          className="w-full max-w-[420px] rounded-card border-border bg-canvas px-3.5 pb-3.5"
          style={{
            borderWidth: HAIRLINE,
            height: Math.min(WEB_CARD_MAX_HEIGHT, height - WEB_CARD_MARGIN * 2),
          }}
        >
          {children}
        </View>
      </View>
    );
  }

  return <View className={frameClasses[isIos ? "sheet" : "fullScreen"]}>{children}</View>;
}
