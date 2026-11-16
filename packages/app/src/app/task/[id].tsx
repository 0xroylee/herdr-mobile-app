import { useLocalSearchParams } from "expo-router";
import { TaskScreen } from "../../screens/task/TaskScreen.tsx";
import { shouldFocusFollowUp } from "../../screens/task/task-screen-controller.ts";

export default function TaskRoute() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    focus?: string | string[];
  }>();
  const taskId = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");

  return <TaskScreen focusFollowUp={shouldFocusFollowUp(params.focus)} taskId={taskId} />;
}
