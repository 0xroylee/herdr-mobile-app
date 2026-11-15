import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { useConnectionManager } from "@/boot.tsx";
import type { MachineSpaceGroup } from "@/model/spaces.ts";
import { findSpaceForTarget } from "@/model/startAgent.ts";
import { routes } from "@/routes.ts";
import { Banner } from "@/ui/components/Banner.tsx";
import { EmptyState } from "@/ui/components/EmptyState.tsx";
import { IconButton } from "@/ui/components/IconButton.tsx";
import { ListGroup } from "@/ui/components/ListGroup.tsx";
import { ScreenHeader } from "@/ui/components/ScreenHeader.tsx";
import { Tag } from "@/ui/components/Tag.tsx";
import { FlashList } from "@/ui/list.ts";
import { Text } from "@/ui/text.tsx";
import type { SpacesBanner } from "./connectionPresentation.ts";
import { PairAgainBanner } from "./PairAgainBanner.tsx";
import { SpaceRow } from "./SpaceRow.tsx";
import { spaceStartTarget } from "./start-entry.ts";
import { useSpaces } from "./useSpaces.ts";
import { getSpaceExpansionKey, groupHeading, groupTag, spacesFootnote } from "./viewState.ts";

export function SpacesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    created?: string | string[];
    space?: string | string[];
    started?: string | string[];
  }>();
  const connectionManager = useConnectionManager();
  const {
    canCreate,
    createSpace,
    expandedSpaceKeys,
    groups,
    isCreating,
    isExpanded,
    layout,
    machine,
    message,
    presentation,
    toggleSpace,
  } = useSpaces();
  const startedPlacement = firstParam(params.started);
  const createdType = firstParam(params.created);
  const startedSpaceId = firstParam(params.space);
  const [startedNotice, setStartedNotice] = useState<string>();

  useEffect(() => {
    if (!startedPlacement && createdType !== "tab") return;
    setStartedNotice(
      createdType === "tab"
        ? "Empty tab created in Herdr."
        : startedPlacement === "window"
          ? "Started in Herdr."
          : "Started in herdr-core. Herdr shows it when it opens.",
    );
    if (startedSpaceId) {
      const space = findSpaceForTarget(
        startedSpaceId,
        groups.flatMap((group) => group.spaces),
        layout,
      );
      if (!space) return;
      const group = groups.find((candidate) => candidate.spaces.includes(space));
      if (group) {
        const key = getSpaceExpansionKey(group.id, space.id);
        if (!isExpanded(key)) toggleSpace(key);
      }
    }
    router.setParams({ created: undefined, space: undefined, started: undefined });
  }, [
    createdType,
    groups,
    isExpanded,
    layout,
    router,
    startedPlacement,
    startedSpaceId,
    toggleSpace,
  ]);

  const bannerRenderers: Record<SpacesBanner["kind"], (message: string) => ReactNode> = {
    reconnecting: (message) => <Banner message={message} state="reconnecting" />,
    offline: (message) => (
      <Banner message={message} onRetry={() => connectionManager?.start()} state="offline" />
    ),
    unauthorized: (message) => (
      <PairAgainBanner message={message} onPair={() => router.push("/pair" as Href)} />
    ),
  };

  const openAgent = (address: string) => {
    router.push({ pathname: "/agent/[address]", params: { address } } as Href);
  };

  return (
    <View className="flex-1 bg-canvas px-3.5 pt-safe">
      <ScreenHeader title="Spaces">
        {canCreate ? (
          <IconButton
            accessibilityLabel="New space"
            disabled={isCreating}
            icon="plus"
            onPress={createSpace}
            variant="boxed"
          />
        ) : null}
      </ScreenHeader>

      {presentation.banner ? (
        <View className="pb-2.5">
          {bannerRenderers[presentation.banner.kind](presentation.banner.message)}
        </View>
      ) : null}
      {startedNotice ? (
        <View className="pb-2.5 px-1">
          <Text variant="subhead" tone="muted">
            {startedNotice}
          </Text>
        </View>
      ) : null}

      <FlashList
        className="flex-1"
        contentContainerClassName="gap-3 pb-4"
        data={groups}
        extraData={[expandedSpaceKeys, message, canCreate, isCreating]}
        keyExtractor={(item) => (item as MachineSpaceGroup).id}
        ListEmptyComponent={
          <View className="min-h-[280px] flex-1">
            <EmptyState kind="spaces" />
          </View>
        }
        ListFooterComponent={
          <View className="gap-3">
            {message ? (
              <Text accessibilityRole="alert" variant="caption" tone="blocked">
                {message}
              </Text>
            ) : null}
            <Text style={{ textAlign: "center" }} variant="caption" tone="dim">
              {spacesFootnote}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => {
          const group = item as MachineSpaceGroup;
          return (
            <View className="gap-2">
              <View className="flex-row items-center gap-2 px-1 pt-1">
                <Text numberOfLines={1} variant="section" tone="muted">
                  {groupHeading(group, machine?.name)}
                </Text>
                <Tag label={groupTag(group)} />
              </View>
              <ListGroup>
                {group.spaces.map((space) => {
                  const expansionKey = getSpaceExpansionKey(group.id, space.id);
                  const target = spaceStartTarget(machine?.role, space, layout);
                  return (
                    <SpaceRow
                      key={space.id}
                      canStartAgent={target !== undefined}
                      expanded={isExpanded(expansionKey)}
                      onStartAgent={() => {
                        if (target !== undefined) {
                          router.push({
                            pathname: routes.start,
                            params: { space: target },
                          } as Href);
                        }
                      }}
                      onOpenTerminal={openAgent}
                      onToggle={() => toggleSpace(expansionKey)}
                      space={space}
                    />
                  );
                })}
              </ListGroup>
            </View>
          );
        }}
        style={presentation.dimmed ? { opacity: 0.6 } : undefined}
      />
    </View>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
