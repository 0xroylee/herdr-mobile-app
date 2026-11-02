import { View } from "react-native";
import type { EffectiveState } from "../../model/status.ts";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";
import type { AttachmentMode, AttachmentPhase } from "./attachment.ts";

export interface StatusStripProps {
  state: EffectiveState;
  age: string;
  mode: AttachmentMode;
  phase: AttachmentPhase;
}

const stateLabels: Record<EffectiveState, string> = {
  blocked: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

const stateTones: Record<EffectiveState, "blocked" | "done" | "working" | "dim"> = {
  blocked: "blocked",
  done: "done",
  working: "working",
  idle: "dim",
};

export function StatusStrip({ state, age, mode, phase }: StatusStripProps) {
  return (
    <View className="flex-row items-center justify-between px-1.5 pb-2.5">
      <View className="flex-row items-center gap-1.5">
        {state === "blocked" ? (
          <View className="min-h-5 flex-row items-center rounded-sm bg-blocked-tint px-[7px]">
            <Text variant="micro" tone="blocked">
              Needs you · {age}
            </Text>
          </View>
        ) : (
          <>
            <StatusMark state={state} />
            <Text
              style={state === "working" ? { fontWeight: "500" } : undefined}
              variant="subhead"
              tone={stateTones[state]}
            >
              {stateLabels[state]} · {age}
            </Text>
          </>
        )}
      </View>
      <View className="flex-row items-center gap-1.5">
        {phase === "connected" ? (
          mode === "watching" ? (
            <Icon color="dim" name="eye" size={15} />
          ) : null
        ) : null}
        <Text variant="subhead" tone={phase === "connected" && mode === "control" ? "fg" : "dim"}>
          {phase === "connected"
            ? mode === "control"
              ? "In control"
              : "Watching"
            : phase === "connecting"
              ? "Connecting…"
              : "Disconnected"}
        </Text>
      </View>
    </View>
  );
}
