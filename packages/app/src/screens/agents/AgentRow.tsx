import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { machinePrefix } from "../../model/address.ts";
import type { AgentRow as Agent, AgentSort } from "../../model/agents.ts";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { Tag } from "../../ui/components/Tag.tsx";
import { Text } from "../../ui/text.tsx";
import { blockedQuestionCallout } from "./agents-view.ts";

export interface AgentRowProps {
  agent: Agent;
  sort: AgentSort;
  onPress(): void;
  onLongPress(): void;
}

export function AgentRow({ agent, sort, onPress, onLongPress }: AgentRowProps) {
  const [surface, raised] = useCSSVariable(["--color-surface", "--color-raised"] as const);
  const remoteMachine = machinePrefix(agent.address);
  const questionCallout = blockedQuestionCallout(sort, agent.state, agent.question);

  return (
    <Pressable
      accessibilityLabel={`${agent.title}, ${agent.program.name}, ${agent.state}`}
      accessibilityRole="button"
      delayLongPress={400}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: String(pressed ? raised : surface) })}
    >
      <View className="min-h-[64px] flex-row items-center gap-3 px-3.5 py-2.5">
        <ProgramIcon program={agent.program.name} />
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            variant={agent.state === "idle" ? "body" : "headline"}
            tone={agent.state === "idle" ? "muted" : "fg"}
          >
            {agent.title}
          </Text>
          <View className="mt-0.5">
            <Text numberOfLines={1} variant="subhead" tone="dim">
              {agent.subtitle}
            </Text>
          </View>
          {questionCallout ? (
            <View className="pt-1.75">
              <Text numberOfLines={2} variant="callout" tone="muted">
                {questionCallout}
              </Text>
            </View>
          ) : null}
        </View>
        <View className="shrink-0 flex-row items-center gap-2">
          <Text variant="caption" tone="dim">
            {agent.age}
          </Text>
          {remoteMachine ? <Tag label={remoteMachine} /> : null}
          <StatusMark compact={sort === "priority"} state={agent.state} />
        </View>
      </View>
    </Pressable>
  );
}
