import type { StartAgentSpace } from "@herdr-mobile/protocol";
import * as Haptics from "expo-haptics";
import { type Href, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { useStore } from "zustand";
import { deriveSpaces } from "../../model/spaces.ts";
import { newTabTarget } from "../../model/spaceTarget.ts";
import {
  deriveStartOptions,
  firstMessageNeedsWindow,
  type StartRunChoice,
  type StartRunSelection,
  type StartSpaceChoice,
  startSpaceKey,
} from "../../model/startAgent.ts";
import { createBridgeApi } from "../../net/bridge-api.ts";
import { routes } from "../../routes.ts";
import { appSecrets, coreStore, machinesStore, settingsStore } from "../../store/platform.ts";
import { shortenHomeFolder } from "../../terminal/folder.ts";
import { Banner } from "../../ui/components/Banner.tsx";
import { buttonClasses, HAIRLINE } from "../../ui/components/classes.ts";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Spinner } from "../../ui/components/Spinner.tsx";
import { Text } from "../../ui/text.tsx";
import { createNewTab } from "../spaces/newItems.ts";
import { RunList } from "./RunList.tsx";
import { getStartScreenAccess } from "./start-access.ts";
import { createStartController, dispatchStartAction } from "./start-controller.ts";
import { WherePicker } from "./WherePicker.tsx";

const bridgeApi = createBridgeApi((input, init) => fetch(input, init));
const emptyRecentFolders: string[] = [];

export interface StartScreenProps {
  preselectedSpaceId?: string;
}

export function StartScreen({ preselectedSpaceId }: StartScreenProps) {
  const router = useRouter();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const machineCore = useStore(coreStore, (state) =>
    activeId === null ? undefined : state.machines[activeId],
  );
  const recentFolders = useStore(settingsStore, (state) =>
    activeId === null ? emptyRecentFolders : (state.recentFolders[activeId] ?? emptyRecentFolders),
  );
  const connection = machineCore?.connection ?? "offline";
  const connected = connection === "connected";
  const access = getStartScreenAccess(machine?.role, connected);
  const dim = useCSSVariable("--color-dim");
  const solid = useCSSVariable("--color-solid-fg");
  const placeholderColor = typeof dim === "string" ? dim : undefined;
  const solidForeground = typeof solid === "string" ? solid : undefined;
  const port = useMemo(
    () => ({
      catalog: async () => {
        if (machine?.role !== "control") throw new Error("This device is read-only.");
        const token = await appSecrets.get(machine.id);
        if (!token) throw new Error("The access token for this Mac is unavailable.");
        return bridgeApi.agentCatalog(machine.url, token);
      },
      start: async (request: Parameters<typeof bridgeApi.startAgent>[2]) => {
        if (machine?.role !== "control") throw new Error("This device is read-only.");
        const token = await appSecrets.get(machine.id);
        if (!token) throw new Error("The access token for this Mac is unavailable.");
        const reply = await bridgeApi.startAgent(machine.url, token, request);
        settingsStore.getState().pushRecentFolder(machine.id, request.folder);
        return reply;
      },
      haptic: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
      openAgent: (address: string, placement: "window" | "core") => {
        router.push({
          pathname: "/agent/[address]",
          params: { address, started: placement },
        } as Href);
      },
      openSpaces: (spaceId?: string, placement?: "window" | "core") => {
        router.replace({
          pathname: routes.spaces,
          params: { space: spaceId, started: placement },
        } as Href);
      },
    }),
    [machine, router],
  );
  const controller = useMemo(
    () =>
      createStartController(port, preselectedSpaceId, { role: machine?.role, connected: false }),
    [machine?.role, port, preselectedSpaceId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const preselectedSpaceTargetId = controller.preselectedSpaceTargetId;
  const options = useMemo(
    () =>
      deriveStartOptions(
        state.catalog,
        machineCore?.layout,
        machineCore?.terminals ?? {},
        recentFolders,
        preselectedSpaceId,
        preselectedSpaceTargetId,
      ),
    [
      state.catalog,
      machineCore?.layout,
      machineCore?.terminals,
      recentFolders,
      preselectedSpaceId,
      preselectedSpaceTargetId,
    ],
  );
  const [emptyTabBusy, setEmptyTabBusy] = useState(false);
  const [emptyTabError, setEmptyTabError] = useState<string>();

  useEffect(() => {
    controller.setAccess(machine?.role, connected);
  }, [connected, controller, machine?.role]);

  useEffect(() => {
    if (!access.readOnly) void controller.load();
  }, [access.readOnly, controller]);

  useEffect(() => {
    if (isEditable(state.status)) controller.applyOptions(options);
  }, [controller, options, state.status]);

  const draft = state.draft;
  const selectedRun = options.runChoices.find((choice) => sameRun(choice.selection, draft.run));
  const selectedSpace = options.spaceChoices.find((choice) =>
    sameSpace(choice.selection, draft.space),
  );
  const folders = options.foldersBySpace[startSpaceKey(draft.space) ?? ""] ?? [];
  const terminals = machineCore?.terminals ?? {};
  const selectedSpaceId = draft.space?.kind === "existing" ? draft.space.id : undefined;
  const selectedSpaceChoice = options.spaceChoices.find((choice) =>
    sameSpace(choice.selection, draft.space),
  );
  const selectedSpaceRow = selectedSpaceChoice?.displayId
    ? deriveSpaces(terminals, machineCore?.layout)
        .flatMap((group) => group.spaces)
        .find((space) => space.id === selectedSpaceChoice.displayId)
    : undefined;
  const emptyTabTarget = selectedSpaceRow
    ? newTabTarget(selectedSpaceRow, machineCore?.layout)
    : undefined;
  const busy = state.status === "starting" || emptyTabBusy;
  const fieldsDisabled = !isEditable(state.status) || emptyTabBusy;
  const emptySelected = selectedRun?.kind === "empty";

  async function createEmptyTab() {
    if (!emptyTabTarget || emptyTabBusy) return;
    setEmptyTabError(undefined);
    setEmptyTabBusy(true);
    const result = await controller.createEmptyTabIfAllowed(emptyTabTarget, (target) =>
      createNewTab({ api: bridgeApi, secrets: appSecrets }, machine, target),
    );
    setEmptyTabBusy(false);
    if (!result) return;
    if (!result.ok) {
      setEmptyTabError(result.message);
      return;
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // A haptic failure does not affect tab creation.
    }
    router.replace({
      pathname: routes.spaces,
      params: { space: selectedSpaceId, created: "tab" },
    } as Href);
  }

  function selectSpace(space: StartAgentSpace) {
    controller.set("space", space);
    setEmptyTabError(undefined);
    const folderKey = startSpaceKey(space) ?? "";
    controller.set("folder", options.foldersBySpace[folderKey]?.[0]?.path ?? "");
  }

  if (access.readOnly) {
    return (
      <StartFrame>
        <View className="flex-1 px-3.5">
          <StartHeader onCancel={() => router.back()} />
          <View className="flex-1 items-center justify-center px-6">
            <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
              This device is read-only. Starting agents is available on control devices.
            </Text>
          </View>
        </View>
      </StartFrame>
    );
  }

  const onlineBanner = connected ? undefined : (
    <Banner
      message={
        connection === "unauthorized"
          ? "This device is no longer authorized."
          : connection === "connecting" || connection === "reconnecting"
            ? "Reconnecting to the Mac…"
            : "Can't reach the bridge. Check that Tailscale is on."
      }
      state={
        connection === "connecting" || connection === "reconnecting" ? "reconnecting" : "offline"
      }
    />
  );
  const summary = startSummary(selectedRun, selectedSpace?.name, draft.folder, state.catalog?.home);
  const runName = selectedRun?.kind === "empty" ? undefined : selectedRun?.name;
  const ctaLabel = emptySelected ? "Create empty tab" : `Start ${runName ?? "agent"}`;
  const emptyUnavailable = emptySelected && emptyTabTarget === undefined;
  const startDisabled =
    !access.canStart ||
    busy ||
    !isEditable(state.status) ||
    !selectedRun ||
    !selectedSpace ||
    emptyUnavailable;

  return (
    <StartFrame>
      <View className="px-3.5">
        <StartHeader onCancel={() => router.back()} />
      </View>
      {onlineBanner ? <View className="px-3.5 pb-2.5">{onlineBanner}</View> : null}
      {state.status === "loading" ? (
        <View className="flex-1 items-center justify-center gap-3">
          <Spinner />
          <Text variant="subhead" tone="muted">
            Loading agent options…
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            className="min-h-0 flex-1"
            contentContainerClassName="gap-4 px-3.5 pb-4"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {state.catalogError || state.refreshAvailable ? (
              <View className="flex-row items-center justify-between gap-3 px-1">
                <View className="min-w-0 flex-1">
                  <Text variant="subhead" tone="dim">
                    {state.catalogError
                      ? "Agent options couldn't load. Built-in programs are available."
                      : "Agent options may have changed."}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !isEditable(state.status) }}
                  disabled={busy || !isEditable(state.status)}
                  onPress={() => void controller.load()}
                  style={{ opacity: busy || !isEditable(state.status) ? 0.4 : 1 }}
                >
                  <Text variant="button" tone="muted">
                    Refresh
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <View className="gap-2">
              <Text variant="section" tone="muted">
                Run
              </Text>
              <RunList
                choices={options.runChoices}
                disabled={fieldsDisabled}
                error={isEditable(state.status) ? state.fieldErrors?.run : undefined}
                onSelect={(run: StartRunSelection) => {
                  controller.set("run", run);
                  setEmptyTabError(undefined);
                }}
                selected={draft.run}
              />
            </View>

            <View className="gap-2">
              <Text variant="section" tone="muted">
                Where
              </Text>
              <WherePicker
                disabled={fieldsDisabled}
                folder={draft.folder}
                folderError={isEditable(state.status) ? state.fieldErrors?.folder : undefined}
                folders={folders}
                home={state.catalog?.home}
                onFolderChange={(folder) => controller.set("folder", folder)}
                onSpaceChange={selectSpace}
                selectedSpace={draft.space}
                spaceError={isEditable(state.status) ? state.fieldErrors?.space : undefined}
                spaces={options.spaceChoices}
                showFolder={!emptySelected}
              />
            </View>

            {!emptySelected ? (
              <View className="gap-2">
                <Text variant="section" tone="muted">
                  First message
                </Text>
                <View
                  className="rounded-field border-border bg-surface p-3.5"
                  style={{ borderWidth: HAIRLINE }}
                >
                  <TextInput
                    accessibilityLabel="First message"
                    className="min-h-[92px] p-0 font-sans text-[15px] leading-[21px] text-fg"
                    editable={!fieldsDisabled}
                    multiline
                    onChangeText={(task) => controller.set("task", task)}
                    placeholder={`What should ${runName ?? "the agent"} do? Optional`}
                    placeholderTextColor={placeholderColor}
                    textAlignVertical="top"
                    value={draft.task}
                  />
                </View>
                {firstMessageNeedsWindow(state.catalog, draft.run) ? (
                  <Text variant="caption" tone="dim">
                    {runName ?? "This program"} gets a first message only while Herdr is open on
                    your Mac.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          <View className="gap-2 border-t-border bg-canvas px-3.5 pb-safe pt-2.5">
            <Text numberOfLines={2} variant="subhead" tone="muted">
              {summary}
            </Text>
            <StartButton
              disabled={startDisabled}
              label={busy && !emptySelected ? `Starting ${runName ?? "agent"}…` : ctaLabel}
              loading={busy}
              onPress={() => {
                void dispatchStartAction(draft.run, {
                  start: () => controller.start(),
                  createEmptyTab,
                });
              }}
              solidForeground={solidForeground}
            />
            {isEditable(state.status) && state.error && !state.fieldErrors?.folder ? (
              <Text accessibilityRole="alert" variant="caption" tone="blocked">
                {state.error}
              </Text>
            ) : null}
            {emptyTabError ? (
              <Text accessibilityRole="alert" variant="caption" tone="blocked">
                {emptyTabError}
              </Text>
            ) : emptyUnavailable ? (
              <Text variant="caption" tone="blocked">
                This space can't receive a new tab right now.
              </Text>
            ) : null}
          </View>
        </>
      )}
    </StartFrame>
  );
}

function StartFrame({ children }: { children: ReactNode }) {
  const isWeb = Platform.OS === "web";
  return (
    <View
      className={
        isWeb ? "flex-1 items-center justify-center bg-canvas px-6 py-6" : "flex-1 bg-canvas"
      }
    >
      <View
        className={
          isWeb
            ? "flex-1 w-full max-w-[620px] overflow-hidden rounded-card border-border bg-canvas pt-safe"
            : "flex-1 bg-canvas pt-safe"
        }
        style={isWeb ? { borderWidth: HAIRLINE, maxHeight: 900 } : undefined}
      >
        {children}
      </View>
    </View>
  );
}

function StartHeader({ onCancel }: { onCancel(): void }) {
  return (
    <View className="min-h-[50px] items-center justify-center">
      <View className="absolute left-0">
        <IconButton accessibilityLabel="Cancel" icon="x" onPress={onCancel} />
      </View>
      <Text numberOfLines={1} style={{ textAlign: "center" }} variant="title">
        Start agent
      </Text>
    </View>
  );
}

interface StartButtonProps {
  label: string;
  disabled: boolean;
  loading: boolean;
  solidForeground: string | undefined;
  onPress(): void;
}

function StartButton({ label, disabled, loading, solidForeground, onPress }: StartButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {({ pressed }) => (
        <View className={buttonClasses.large[pressed && !disabled ? "pressed" : "rest"]}>
          <View className="flex-row items-center justify-center gap-2">
            {loading ? (
              <ActivityIndicator color={solidForeground ?? "#131619"} size="small" />
            ) : null}
            <Text variant="buttonLarge" tone={pressed && !disabled ? "fg" : "solid-fg"}>
              {label}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

function sameRun(left: StartRunChoice["selection"], right: StartRunSelection | undefined): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "empty") return right.kind === "empty";
  return left.kind === "program"
    ? right.kind === "program" && left.id === right.id
    : right.kind === "template" && left.name === right.name;
}

function sameSpace(
  left: StartSpaceChoice["selection"],
  right: StartSpaceChoice["selection"] | undefined,
): boolean {
  if (!right || left.kind !== right.kind) return false;
  return left.kind === "existing"
    ? right.kind === "existing" && left.id === right.id
    : right.kind === "new";
}

function isEditable(status: "loading" | "editing" | "starting" | "done" | "error"): boolean {
  return status === "editing" || status === "error";
}

function startSummary(
  selectedRun: StartRunChoice | undefined,
  spaceName: string | undefined,
  folder: string,
  home: string | undefined,
): string {
  if (selectedRun?.kind === "empty")
    return `Empty tab · ${spaceName ?? "Choose a space"} › new tab`;
  const parts = [
    selectedRun?.name ?? "Choose an agent",
    folder ? shortenHomeFolder(folder, home) : "Choose a folder",
    `${spaceName ?? "Choose a space"} › new tab`,
  ];
  return parts.join(" · ");
}
