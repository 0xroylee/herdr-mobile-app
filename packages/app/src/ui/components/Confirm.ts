import { Alert } from "react-native";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      options.title,
      options.message,
      [
        { text: options.cancelLabel ?? "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: options.confirmLabel ?? "Confirm",
          style: "destructive",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
