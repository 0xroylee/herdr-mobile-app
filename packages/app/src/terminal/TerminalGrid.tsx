import { useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type ScrollViewInstance,
  type TextStyle,
  View,
} from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  ScrollView,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import { useCSSVariable } from "uniwind";
import { Text } from "../ui/text.tsx";
import type { TerminalPalette } from "./palette.ts";
import { terminalColorHex } from "./palette.ts";
import type { ScreenRow, ScreenRun, ScreenSnapshot, TerminalColor } from "./snapshot.ts";
import {
  cellSizeForZoom,
  DEFAULT_ZOOM,
  resetZoom,
  scrollOffsetToBottom,
  zoomFromPinch,
} from "./zoom.ts";

export interface TerminalGridProps {
  snapshot: ScreenSnapshot;
  palette: TerminalPalette;
}

interface ViewportSize {
  width: number;
  height: number;
}

function colorIdentity(color: TerminalColor): string {
  if (color.kind === "default") return "default";
  if (color.kind === "ansi") return `ansi:${color.index}`;
  return `rgb:${color.hex}`;
}

function runIdentity(run: ScreenRun): string {
  return [
    run.text,
    colorIdentity(run.fg),
    colorIdentity(run.bg),
    run.bold ? "bold" : "regular",
    run.inverse ? "inverse" : "normal",
  ].join("\u0000");
}

function rowIdentity(row: ScreenRow): string {
  return row.map(runIdentity).join("\u0001");
}

function withStableKeys<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
  prefix: string,
): { key: string; value: Value }[] {
  const occurrences = new Map<string, number>();

  return values.map((value) => {
    const valueIdentity = identity(value);
    const occurrence = occurrences.get(valueIdentity) ?? 0;
    occurrences.set(valueIdentity, occurrence + 1);
    return { key: `${prefix}-${valueIdentity}-${occurrence}`, value };
  });
}

function cssColor(value: string | number | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function terminalRunStyle(
  run: ScreenRun,
  palette: TerminalPalette,
  cellSize: ReturnType<typeof cellSizeForZoom>,
  termForeground: string | undefined,
  termBackground: string | undefined,
): TextStyle {
  const foreground: TerminalColor = run.inverse ? run.bg : run.fg;
  const background: TerminalColor = run.inverse ? run.fg : run.bg;
  const color =
    foreground.kind === "default"
      ? run.inverse
        ? termBackground
        : undefined
      : terminalColorHex(foreground, palette);
  const backgroundColor =
    background.kind === "default"
      ? run.inverse
        ? termForeground
        : undefined
      : terminalColorHex(background, palette);

  return {
    fontSize: cellSize.fontSize,
    lineHeight: cellSize.height,
    color,
    backgroundColor,
  };
}

function onLayout(setSize: (size: ViewportSize) => void) {
  return (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };
}

export function TerminalGrid({ snapshot, palette }: TerminalGridProps) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });
  const [scrollOffset, setScrollOffset] = useState(0);
  const verticalScroll = useRef<ScrollViewInstance | null>(null);
  const startZoom = useRef(DEFAULT_ZOOM);
  const currentZoom = useRef(DEFAULT_ZOOM);
  const [termForegroundValue, termBackgroundValue] = useCSSVariable([
    "--color-term-fg",
    "--color-term-bg",
  ]);
  const termForeground = cssColor(termForegroundValue);
  const termBackground = cssColor(termBackgroundValue);

  const setBoundedZoom = (nextZoom: number) => {
    currentZoom.current = nextZoom;
    setZoom(nextZoom);
  };

  const pinch = usePinchGesture({
    runOnJS: true,
    onBegin: () => {
      startZoom.current = currentZoom.current;
    },
    onUpdate: ({ scale }) => {
      setBoundedZoom(zoomFromPinch(startZoom.current, scale));
    },
  });
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onActivate: () => setBoundedZoom(resetZoom()),
  });
  const gesture = useSimultaneousGestures(pinch, doubleTap);

  const cellSize = cellSizeForZoom(zoom);
  const contentWidth = snapshot.cols * cellSize.width;
  const gridHeight = snapshot.rows.length * cellSize.height;
  const contentHeight = Math.max(viewport.height, gridHeight);
  const gridOffset = scrollOffsetToBottom(contentHeight, gridHeight);
  const maxScroll = Math.max(0, contentWidth - viewport.width);
  const isScrollable = maxScroll > 1;
  const trackWidth = viewport.width;
  const thumbWidth = isScrollable
    ? Math.min(trackWidth, Math.max(18, (trackWidth * viewport.width) / contentWidth))
    : trackWidth;
  const clampedScrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const thumbOffset =
    isScrollable && maxScroll > 0
      ? ((trackWidth - thumbWidth) * clampedScrollOffset) / maxScroll
      : 0;
  const cursorColor = palette.cursor === "term-fg" ? termForeground : undefined;
  const keyedRows = withStableKeys(snapshot.rows, rowIdentity, "row");
  const verticalScrollTarget = useMemo(
    () => ({
      contentHeight,
      viewportHeight: viewport.height,
      viewportWidth: viewport.width,
      rowCount: snapshot.rows.length,
      zoom,
    }),
    [contentHeight, snapshot.rows.length, viewport.height, viewport.width, zoom],
  );

  useEffect(() => {
    verticalScroll.current?.scrollTo({
      x: 0,
      y: scrollOffsetToBottom(
        verticalScrollTarget.contentHeight,
        verticalScrollTarget.viewportHeight,
      ),
      animated: false,
    });
  }, [verticalScrollTarget]);

  return (
    <GestureHandlerRootView className="flex-1">
      <View className="flex-1 overflow-hidden px-3 py-2.5">
        <GestureDetector gesture={gesture}>
          <ScrollView
            ref={verticalScroll}
            className="flex-1"
            onLayout={onLayout(setViewport)}
            showsVerticalScrollIndicator={false}
          >
            <ScrollView
              className="w-full"
              horizontal
              onScroll={(event) => setScrollOffset(event.nativeEvent.contentOffset.x)}
              scrollEventThrottle={16}
              showsHorizontalScrollIndicator={false}
              style={{ height: contentHeight }}
            >
              <View className="justify-end" style={{ width: contentWidth, height: contentHeight }}>
                {keyedRows.map(({ key: rowKey, value: row }) => (
                  <Text
                    key={rowKey}
                    allowFontScaling={false}
                    numberOfLines={1}
                    style={{
                      width: contentWidth,
                      fontSize: cellSize.fontSize,
                      lineHeight: cellSize.height,
                    }}
                    variant="terminal"
                  >
                    {withStableKeys(row, runIdentity, "run").map(({ key, value: run }) => (
                      <Text
                        key={key}
                        allowFontScaling={false}
                        style={terminalRunStyle(
                          run,
                          palette,
                          cellSize,
                          termForeground,
                          termBackground,
                        )}
                        variant={run.bold ? "terminalBold" : "terminal"}
                      >
                        {run.text}
                      </Text>
                    ))}
                  </Text>
                ))}
                {snapshot.cursor.visible ? (
                  <View
                    className="absolute left-0 top-0 opacity-50"
                    pointerEvents="none"
                    style={{
                      backgroundColor: cursorColor,
                      height: cellSize.height,
                      left: snapshot.cursor.x * cellSize.width,
                      top: gridOffset + snapshot.cursor.y * cellSize.height,
                      width: cellSize.width,
                    }}
                  />
                ) : null}
              </View>
            </ScrollView>
          </ScrollView>
        </GestureDetector>
        {isScrollable ? (
          <View className="relative mt-1 h-[3px] w-full overflow-hidden rounded-full bg-scroll-track">
            <View
              className="absolute left-0 top-0 h-[3px] rounded-full bg-scroll-thumb"
              style={{
                transform: [{ translateX: thumbOffset }],
                width: thumbWidth,
              }}
            />
          </View>
        ) : null}
      </View>
    </GestureHandlerRootView>
  );
}
