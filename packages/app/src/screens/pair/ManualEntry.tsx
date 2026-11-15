import { TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Button } from "../../ui/components/Button.tsx";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { Text } from "../../ui/text.tsx";

const CANCEL_LABEL = "Cancel";

export interface ManualEntryProps {
  address: string;
  code: string;
  busy: boolean;
  onAddressChange(value: string): void;
  onCodeChange(value: string): void;
  onPair(): void;
  onCancel(): void;
}

export function ManualEntry({
  address,
  code,
  busy,
  onAddressChange,
  onCodeChange,
  onPair,
  onCancel,
}: ManualEntryProps) {
  const dim = useCSSVariable("--color-dim");
  const placeholderColor = typeof dim === "string" ? dim : undefined;

  return (
    <View
      className="gap-3 rounded-card border-border bg-surface p-3.5"
      style={{ borderWidth: HAIRLINE }}
    >
      <Text variant="headline">Enter bridge details</Text>
      <Text variant="caption" tone="muted">
        Typing works over Tailscale. Without it, scan the code or paste the full link.
      </Text>
      <View className="gap-1.5">
        <Text variant="caption" tone="muted">
          Bridge URL or pairing link
        </Text>
        <TextInput
          accessibilityLabel="Bridge URL or pairing link"
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-11 rounded-btn border-border bg-canvas px-3 font-sans text-[15px] leading-[21px] text-fg"
          keyboardType="url"
          onChangeText={onAddressChange}
          placeholder="https://mac.tailnet.ts.net"
          placeholderTextColor={placeholderColor}
          style={{ borderWidth: HAIRLINE }}
          value={address}
        />
      </View>
      <View className="gap-1.5">
        <Text variant="caption" tone="muted">
          8-character code
        </Text>
        <TextInput
          accessibilityLabel="Pairing code"
          autoCapitalize="characters"
          autoCorrect={false}
          className="min-h-11 rounded-btn border-border bg-canvas px-3 font-mono text-[15px] leading-[20px] text-fg"
          maxLength={8}
          onChangeText={onCodeChange}
          placeholder="ABCD2345"
          placeholderTextColor={placeholderColor}
          style={{ borderWidth: HAIRLINE }}
          value={code}
        />
      </View>
      <View className="flex-row justify-end gap-2 pt-1">
        <Button disabled={busy} onPress={onCancel} variant="outline">
          {CANCEL_LABEL}
        </Button>
        <Button disabled={busy} onPress={onPair}>
          {busy ? "Pairing…" : "Pair device"}
        </Button>
      </View>
    </View>
  );
}
