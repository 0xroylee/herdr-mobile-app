import { Pressable, View } from "react-native";
import type { StartRunChoice, StartRunSelection } from "../../model/startAgent.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { ProgramIcon } from "../../ui/components/ProgramIcon.tsx";
import { Icon } from "../../ui/icon.tsx";
import { Text } from "../../ui/text.tsx";

const rowClasses = {
  rest: "min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[58px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export interface RunListProps {
  choices: readonly StartRunChoice[];
  selected: StartRunSelection | undefined;
  disabled: boolean;
  error?: string;
  onSelect(selection: StartRunSelection): void;
}

export function RunList({ choices, selected, disabled, error, onSelect }: RunListProps) {
  return (
    <View className="gap-1.5">
      <ListGroup>
        {choices.map((choice) => {
          const isSelected = runSelectionKey(choice.selection) === runSelectionKey(selected);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled }}
              disabled={disabled}
              key={choice.key}
              onPress={() => onSelect(choice.selection)}
            >
              {({ pressed }) => (
                <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                  {choice.kind === "empty" ? (
                    <Icon color="muted" name="terminal" size={18} />
                  ) : (
                    <ProgramIcon program={choice.program ?? choice.name} size="row" />
                  )}
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} variant="headline">
                      {choice.name}
                    </Text>
                    <Text numberOfLines={1} variant="subhead" tone="dim">
                      {choice.description}
                    </Text>
                  </View>
                  {isSelected ? <Icon color="fg" name="check" size={17} /> : null}
                </View>
              )}
            </Pressable>
          );
        })}
      </ListGroup>
      {error ? (
        <Text accessibilityRole="alert" variant="caption" tone="blocked">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function runSelectionKey(selection: StartRunSelection | undefined): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "empty") return "empty";
  return selection.kind === "program" ? `program:${selection.id}` : `template:${selection.name}`;
}
