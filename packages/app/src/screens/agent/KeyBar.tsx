import { ScrollView } from "react-native";
import { KEY_BAR_KEYS } from "./actions.ts";
import { Key } from "./Key.tsx";

export interface KeyBarProps {
  disabled?: boolean;
  onKey(key: string): void;
}

export function KeyBar({ disabled = false, onKey }: KeyBarProps) {
  return (
    <ScrollView
      className="mb-1.5 max-h-11"
      contentContainerClassName="flex-row items-center gap-1.5"
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {KEY_BAR_KEYS.map(({ label, key }) => (
        <Key key={key} disabled={disabled} label={label} onPress={() => onKey(key)} />
      ))}
    </ScrollView>
  );
}
