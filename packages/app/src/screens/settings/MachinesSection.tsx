import { useMemo, useRef, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useConnectionManager } from "../../boot.tsx";
import { appSecrets, machinesStore } from "../../store/platform.ts";
import { Banner } from "../../ui/components/Banner.tsx";
import { Button } from "../../ui/components/Button.tsx";
// This extensionless import lets Metro select Confirm.web.ts on web.
import { confirm } from "../../ui/components/Confirm";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { ListGroup } from "../../ui/components/ListGroup.tsx";
import { Tag } from "../../ui/components/Tag.tsx";
import { Text } from "../../ui/text.tsx";
import { createMachineRemovalController, machineHostName } from "./settings-actions.ts";

export function MachinesSection() {
  const machineMap = machinesStore((state) => state.machines);
  const activeId = machinesStore((state) => state.activeId);
  const manager = useConnectionManager();
  const activeIdRef = useRef(activeId);
  const managerRef = useRef(manager);
  activeIdRef.current = activeId;
  managerRef.current = manager;
  const machines = Object.values(machineMap);
  const controller = useMemo(
    () =>
      createMachineRemovalController(appSecrets, machinesStore, confirm, (machine) =>
        machine.id === activeIdRef.current ? managerRef.current : undefined,
      ),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return (
    <View className="gap-2">
      {state.message ? <Banner message={state.message} state="offline" /> : null}
      {machines.length === 0 ? (
        <View
          className="rounded-group border-border bg-surface px-3.5 py-4"
          style={{ borderWidth: HAIRLINE }}
        >
          <Text variant="callout">No paired machines.</Text>
        </View>
      ) : (
        <ListGroup>
          {machines.map((machine) => (
            <View
              className="min-h-[58px] flex-row items-center gap-3 px-3.5 py-2.5"
              key={machine.id}
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1} variant="headline">
                  {machine.name}
                </Text>
                <Text numberOfLines={1} variant="subhead">
                  {machineHostName(machine)}
                </Text>
              </View>
              <Tag label={machine.role} />
              <Button
                disabled={state.confirming || state.removingId !== undefined}
                onPress={() => void controller.remove(machine)}
                variant="danger"
              >
                {state.removingId === machine.id ? "Removing…" : "Remove"}
              </Button>
            </View>
          ))}
        </ListGroup>
      )}
    </View>
  );
}
