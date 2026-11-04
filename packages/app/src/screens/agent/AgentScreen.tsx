import type { StartAgentPlacement } from "@herdr-mobile/protocol";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useStore } from "zustand";
import { useConnectionManager } from "../../boot.tsx";
import { startPlacementNotice } from "../../model/startAgent.ts";
import { coreStore, machinesStore, seenStore } from "../../store/platform.ts";
import { TerminalPane } from "../../terminal/TerminalPane.tsx";
import type { TerminalFit } from "../../terminal/zoom.ts";
import { Banner } from "../../ui/components/Banner.tsx";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { Text } from "../../ui/text.tsx";
import {
  type AgentActionPort,
  copyAddress,
  endTerminal,
  interruptAgent,
  sendMessage,
  takeOver,
} from "./actions.ts";
import { createAgentActionPort } from "./agent-effects.ts";
import { Composer } from "./Composer.tsx";
import { KeyBar } from "./KeyBar.tsx";
import { MoreMenu } from "./MoreMenu.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { StatusStrip } from "./StatusStrip.tsx";
import {
  AutoTakeoverController,
  markOpeningTurnSeen,
  OpeningSeenTracker,
  selectAgentScreen,
  selectTerminal,
  useAgentActionController,
} from "./screen-controller.ts";
import { useAttachment } from "./useAttachment.ts";
import { useSent } from "./useSent.ts";
import { useTerminalInput } from "./useTerminalInput.ts";

export interface AgentScreenProps {
  address: string;
  requestTakeover?: boolean;
  startedPlacement?: StartAgentPlacement;
}

export function AgentScreen({
  address,
  requestTakeover = false,
  startedPlacement,
}: AgentScreenProps) {
  const router = useRouter();
  const manager = useConnectionManager();
  const activeId = useStore(machinesStore, (state) => state.activeId);
  const machine = useStore(machinesStore, (state) =>
    state.activeId ? state.machines[state.activeId] : undefined,
  );
  const machineCore = useStore(coreStore, (state) =>
    activeId ? state.machines[activeId] : undefined,
  );
  const seen = useStore(seenStore, (state) => state.seen);
  const [now, setNow] = useState(() => Date.now());
  const [fit, setFit] = useState<TerminalFit | undefined>(undefined);
  const fitRef = useRef<TerminalFit | undefined>(undefined);
  const [moreVisible, setMoreVisible] = useState(false);
  const [startedNotice, setStartedNotice] = useState(() =>
    startedPlacement ? startPlacementNotice(startedPlacement) : undefined,
  );
  const [seenTracker] = useState(() => new OpeningSeenTracker());
  const [autoTakeover] = useState(() => new AutoTakeoverController());
  const actionController = useAgentActionController();

  const terminal = selectTerminal(machineCore, address);
  const attachment = useAttachment(
    manager,
    address,
    terminal !== undefined,
    terminal?.cols ?? 80,
    terminal?.rows ?? 24,
    { state: terminal?.state ?? "live", pid: terminal?.pid },
  );
  const sent = useSent(terminal?.status);
  const attachmentTakeOver = attachment.takeOver;
  const view = useMemo(
    () =>
      selectAgentScreen({
        address,
        activeId,
        machine,
        machineCore,
        seen,
        now,
        snapshot: attachment.snapshot,
        attachment,
      }),
    [activeId, address, attachment, machine, machineCore, now, seen],
  );
  const port = useMemo<AgentActionPort>(
    () => createAgentActionPort(manager, { takeOver: attachmentTakeOver }),
    [attachmentTakeOver, manager],
  );
  const { answering, pressKey, answerPrompt } = useTerminalInput(
    address,
    port,
    actionController.run,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (startedPlacement === undefined) return;
    setStartedNotice(startPlacementNotice(startedPlacement));
    router.setParams({ started: undefined });
  }, [router, startedPlacement]);

  useEffect(() => {
    markOpeningTurnSeen(
      seenTracker,
      activeId,
      address,
      terminal?.turn,
      (machineId, targetAddress, turn) => seenStore.getState().mark(machineId, targetAddress, turn),
    );
  }, [activeId, address, seenTracker, terminal?.turn]);

  const handleFit = useCallback((nextFit: TerminalFit) => {
    fitRef.current = nextFit;
    setFit((current) =>
      current?.cols === nextFit.cols && current.rows === nextFit.rows ? current : nextFit,
    );
  }, []);

  const runTakeOver = useCallback(async () => {
    const result = await actionController.run(() => takeOver(port, () => fitRef.current));
    return result.ok && result.value;
  }, [actionController.run, port]);

  useEffect(() => {
    if (
      autoTakeover.shouldStart({
        requested: requestTakeover,
        canControl: view.canControl,
        connected: view.connected,
        fit,
      })
    ) {
      void runTakeOver();
    }
  }, [autoTakeover, fit, requestTakeover, runTakeOver, view.canControl, view.connected]);

  const submitMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const result = await actionController.run(() =>
        sendMessage(port, address, text, view.state === "blocked"),
      );
      if (!result.ok || !result.value) return false;
      sent.markSent();
      return true;
    },
    [actionController.run, address, port, sent, view.state],
  );

  const submitPromptAnswer = useCallback(
    async (keys: readonly string[]) => {
      if (await answerPrompt(keys)) sent.markSent();
    },
    [answerPrompt, sent],
  );

  const runInterrupt = () => void actionController.run(() => interruptAgent(port, address));
  const runCopy = () => void actionController.run(() => copyAddress(port, address));
  const runEnd = () => void actionController.run(() => endTerminal(port, address));
  const goBack = () => {
    void attachment.detach();
    router.back();
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-canvas px-2.5 pt-safe pb-safe"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="min-h-[50px] flex-row items-center">
        <IconButton accessibilityLabel="Back" icon="chevron-left" onPress={goBack} size="back" />
        <View className="min-w-0 flex-1 justify-center">
          <Text numberOfLines={1} variant="title">
            {view.title}
          </Text>
          <Text numberOfLines={1} variant="subhead">
            {view.subtitle}
          </Text>
        </View>
        {view.showMoreMenu ? (
          <IconButton
            accessibilityLabel="More options"
            icon="ellipsis"
            onPress={() => setMoreVisible(true)}
          />
        ) : (
          <View className="h-11 w-11" />
        )}
      </View>

      {startedNotice ? (
        <View className="pb-2.5 px-1">
          <Text variant="subhead" tone="muted">
            {startedNotice}
          </Text>
        </View>
      ) : null}

      <StatusStrip
        age={view.age}
        mode={attachment.mode}
        phase={attachment.phase}
        state={view.state}
      />
      {view.showBanner ? (
        <View className="mb-2">
          <Banner
            state={view.reconnecting ? "reconnecting" : "offline"}
            message={view.bannerMessage}
          />
        </View>
      ) : null}

      <View className="min-h-0 flex-1" style={{ opacity: view.connected ? 1 : 0.6 }}>
        {terminal ? (
          <TerminalPane
            folder={terminal.cwd}
            onFit={handleFit}
            program={view.program.name}
            snapshot={attachment.snapshot}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text variant="callout">Terminal unavailable</Text>
          </View>
        )}
      </View>

      {view.prompt && terminal ? (
        <PromptCard
          age={view.age}
          disabled={view.disabled}
          onChoice={(keys) => void submitPromptAnswer(keys)}
          pending={answering}
          program={view.program.name}
          prompt={view.prompt}
          readOnly={!view.showPromptChoices}
          sent={sent.sent}
        />
      ) : null}

      {view.showKeyBar ? (
        <KeyBar disabled={view.disabled} onKey={(key) => void pressKey(key)} />
      ) : null}
      <Composer
        disabled={view.disabled}
        error={actionController.error ?? attachment.error}
        onSend={submitMessage}
        placeholder={view.placeholder}
        program={view.program.name}
        readOnly={view.readOnly}
        sent={sent.sent}
      />

      {view.showMoreMenu ? (
        <MoreMenu
          actionsDisabled={view.disabled}
          onClose={() => setMoreVisible(false)}
          onCopyAddress={runCopy}
          onEndTerminal={runEnd}
          onInterrupt={runInterrupt}
          onTakeOver={() => void runTakeOver()}
          takeoverDisabled={view.disabled || attachment.mode === "control"}
          visible={moreVisible}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
