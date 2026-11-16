import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import type { TaskProject } from "../../model/tasks.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { modalFrameTopInsetClass } from "../../ui/modal-frame.ts";
import { Text } from "../../ui/text.tsx";

const rowClasses = {
  rest: "min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5",
  pressed: "min-h-[58px] flex-row items-center gap-3 bg-raised px-3.5 py-2.5",
} as const;

export function ProjectPickerSheet({
  visible,
  projects,
  onClose,
  onSelect,
}: {
  visible: boolean;
  projects: readonly TaskProject[];
  onClose(): void;
  onSelect(projectId: string): void;
}) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View className={`flex-1 bg-canvas px-3.5 ${modalFrameTopInsetClass(Platform.OS)}`}>
        <View className="flex-row items-center pb-2.5">
          <IconButton accessibilityLabel="Cancel" icon="x" onPress={onClose} />
          <Text variant="title">New task</Text>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="pb-5">
          {projects.length > 0 ? (
            <ListGroup>
              {projects.map((project) => (
                <Pressable
                  accessibilityRole="button"
                  key={project.id}
                  onPress={() => onSelect(project.id)}
                >
                  {({ pressed }) => (
                    <View className={pressed ? rowClasses.pressed : rowClasses.rest}>
                      <View className="min-w-0 flex-1">
                        <Text numberOfLines={1} variant="headline">
                          {project.name}
                        </Text>
                        {project.folder ? (
                          <Text numberOfLines={1} variant="mono" tone="dim">
                            {project.folder}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  )}
                </Pressable>
              ))}
            </ListGroup>
          ) : (
            <View className="min-h-40 items-center justify-center px-6">
              <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
                Add a project first, then you can start a task in it.
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
