import type { FlashListProps } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { type Href, useRouter } from "expo-router";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { useConnectionManager } from "../../boot.tsx";
import { canShowStartEntryPoint } from "../../model/startAgent.ts";
import type { EffectiveState } from "../../model/status.ts";
import { routes } from "../../routes.ts";
import { Banner } from "../../ui/components/Banner.tsx";
import { HAIRLINE } from "../../ui/components/classes.ts";
import { EmptyState } from "../../ui/components/EmptyState.tsx";
import { IconButton } from "../../ui/components/IconButton.tsx";
import { ScreenHeader } from "../../ui/components/ScreenHeader.tsx";
import { SectionHeader } from "../../ui/components/SectionHeader.tsx";
import { StatusMark } from "../../ui/components/StatusMark.tsx";
import { FlashList } from "../../ui/list.ts";
import { Text, type TextTone } from "../../ui/text.tsx";
import { AgentRow } from "./AgentRow.tsx";
import {
  type AgentListEntry,
  connectionPresentation,
  findAgent,
  flattenAgentSections,
} from "./agents-view.ts";
import { MachineChip } from "./MachineChip.tsx";
import {
  type AgentRowAction,
  agentRoute,
  agentRowActions,
  dispatchAgentRowAction,
  retryConnection,
} from "./rowMenu.ts";
import { SearchField } from "./SearchField.tsx";
import { useAgents } from "./useAgents.ts";

const AgentsList = FlashList as unknown as ComponentType<
  FlashListProps<AgentListEntry> & { className?: string }
>;

const rowFrameClasses = {
  only: "overflow-hidden rounded-group border-border bg-surface",
  first: "overflow-hidden rounded-t-group border-x-border border-t-border bg-surface",
  middle: "border-x-border border-t-border bg-surface",
  last: "overflow-hidden rounded-b-group border-x-border border-t-border border-b-border bg-surface",
} as const;

const rowMenuItemClasses = {
  rest: "min-h-12 justify-center rounded-btn px-3",
  pressed: "min-h-12 justify-center rounded-btn bg-raised px-3",
} as const;

const rowMenuCancelClasses = {
  rest: "mt-2 min-h-11 items-center justify-center rounded-btn bg-surface",
  pressed: "mt-2 min-h-11 items-center justify-center rounded-btn bg-raised",
} as const;

const sectionTones: Record<EffectiveState, TextTone> = {
  blocked: "blocked",
  done: "done",
  working: "working",
  idle: "dim",
};

export default function AgentsScreen() {
  const router = useRouter();
  const connectionManager = useConnectionManager();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>();
  const {
    activeId,
    agentCount,
    connection,
    connections,
    machine,
    machines,
    sections,
    setActiveId,
    toggleSort,
    sort,
    spaceCount,
  } = useAgents(query);
  const selectedAgent = findAgent(sections, selectedAddress);
  const rowActions = agentRowActions(machine?.role);
  const presentation = connectionPresentation(connection, agentCount > 0, machine?.name);
  const entries = useMemo(() => flattenAgentSections(sections), [sections]);

  function openAgent(address: string, takeover = false) {
    router.push(agentRoute(address, takeover) as Href);
  }

  async function selectRowAction(action: AgentRowAction) {
    if (!selectedAgent) return;
    const address = selectedAgent.address;
    setSelectedAddress(undefined);
    await dispatchAgentRowAction(action.id, address, {
      copyAddress: async (selectedAddress) => {
        await Clipboard.setStringAsync(selectedAddress);
      },
      takeOver: (selectedAddress) => openAgent(selectedAddress, true),
    });
  }

  return (
    <View className="flex-1 bg-canvas px-3.5 pt-safe">
      <ScreenHeader title="Agents">
        <IconButton
          accessibilityLabel={
            sort === "priority" ? "Sort agents by space" : "Sort agents by priority"
          }
          icon={sort === "priority" ? "clock" : "layers"}
          onPress={toggleSort}
        />
        <IconButton
          accessibilityLabel={searchOpen ? "Close agent search" : "Search agents"}
          icon="search"
          onPress={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setQuery("");
          }}
        />
        {canShowStartEntryPoint(machine?.role) ? (
          <IconButton
            accessibilityLabel="Start agent"
            icon="plus"
            onPress={() => router.push(routes.start as Href)}
          />
        ) : null}
      </ScreenHeader>

      {presentation.banner ? (
        <View className="pb-2.5">
          {presentation.banner.kind === "unauthorized" ? (
            <UnauthorizedBanner
              message={presentation.banner.message}
              onPair={() => router.push("/pair")}
            />
          ) : (
            <Banner
              message={presentation.banner.message}
              onRetry={
                presentation.banner.action === "retry"
                  ? () => retryConnection(connectionManager)
                  : undefined
              }
              state={presentation.banner.kind}
            />
          )}
        </View>
      ) : null}

      <View className="min-h-0 flex-1">
        <MachineChip
          activeId={activeId}
          agentCount={agentCount}
          connections={connections}
          machines={machines}
          onSelect={setActiveId}
          spaceCount={spaceCount}
        />
        {searchOpen ? (
          <View className="pt-2.5">
            <SearchField onChangeText={setQuery} value={query} />
          </View>
        ) : null}

        <View
          className="min-h-0 flex-1"
          style={presentation.dimCachedRows ? { opacity: 0.6 } : undefined}
        >
          <AgentsList
            className="flex-1"
            data={entries}
            keyExtractor={(entry: AgentListEntry) => entry.key}
            ListFooterComponent={<View className="h-3" />}
            ListEmptyComponent={
              query.trim().length > 0 ? (
                <View className="min-h-[240px] flex-1 items-center justify-center px-6">
                  <Text style={{ textAlign: "center" }} variant="callout" tone="dim">
                    No agents match this search.
                  </Text>
                </View>
              ) : (
                <View className="min-h-[240px] flex-1">
                  <EmptyState kind="agents" />
                </View>
              )
            }
            renderItem={({ item }: { item: AgentListEntry }) =>
              item.kind === "header" ? (
                <SectionHeader
                  count={item.section.agents.length}
                  title={item.section.label}
                  tone={
                    sort === "priority" && item.section.state
                      ? sectionTones[item.section.state]
                      : "dim"
                  }
                />
              ) : (
                <View
                  className={rowFrameClasses[item.position]}
                  style={{
                    borderBottomWidth:
                      item.position === "only" || item.position === "last" ? HAIRLINE : 0,
                    borderLeftWidth: HAIRLINE,
                    borderRightWidth: HAIRLINE,
                    borderTopWidth: HAIRLINE,
                  }}
                >
                  <AgentRow
                    agent={item.agent}
                    sort={sort}
                    onLongPress={() => setSelectedAddress(item.agent.address)}
                    onPress={() => openAgent(item.agent.address)}
                  />
                </View>
              )
            }
          />
        </View>
      </View>

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedAddress(undefined)}
        transparent
        visible={selectedAgent !== undefined}
      >
        <View className="flex-1 justify-end bg-black/30">
          <Pressable
            accessibilityLabel="Close agent actions"
            className="absolute inset-0"
            onPress={() => setSelectedAddress(undefined)}
          />
          <View
            className="mx-3.5 mb-3 rounded-card border-border bg-surface p-3.5"
            style={{ borderWidth: HAIRLINE }}
          >
            <View className="pb-1">
              <Text numberOfLines={1} variant="title">
                {selectedAgent?.title ?? "Agent actions"}
              </Text>
            </View>
            <View className="pb-2">
              <Text numberOfLines={1} variant="caption">
                {selectedAgent?.address}
              </Text>
            </View>
            {rowActions.map((action) => (
              <Pressable
                accessibilityRole="button"
                key={action.id}
                onPress={() => void selectRowAction(action)}
              >
                {({ pressed }) => (
                  <View className={pressed ? rowMenuItemClasses.pressed : rowMenuItemClasses.rest}>
                    <Text variant="button">{action.label}</Text>
                  </View>
                )}
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setSelectedAddress(undefined)}>
              {({ pressed }) => (
                <View
                  className={pressed ? rowMenuCancelClasses.pressed : rowMenuCancelClasses.rest}
                >
                  <Text variant="button">Cancel</Text>
                </View>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const pairButtonClasses = {
  rest: "min-h-11 items-center justify-center rounded-btn border-border bg-surface px-3",
  pressed: "min-h-11 items-center justify-center rounded-btn border-border bg-raised px-3",
} as const;

function UnauthorizedBanner({ message, onPair }: { message: string; onPair(): void }) {
  return (
    <View
      className="flex-row items-center gap-3 rounded-group border-border bg-surface px-3.5 py-2.5"
      style={{ borderWidth: HAIRLINE }}
    >
      <StatusMark state="blockedCompact" />
      <View className="min-w-0 flex-1">
        <Text variant="subhead" tone="muted">
          {message}
        </Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onPair}>
        {({ pressed }) => (
          <View
            className={pressed ? pairButtonClasses.pressed : pairButtonClasses.rest}
            style={{ borderWidth: HAIRLINE }}
          >
            <Text variant="button">Pair again</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
