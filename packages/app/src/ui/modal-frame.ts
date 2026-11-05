export function modalFrameTopInsetClass(platform: string, isPageSheet = true): string {
  return platform === "ios" && isPageSheet ? "" : "pt-safe";
}

export function pageSheetKeyboardVerticalOffset(
  platform: string,
  frameLocalY: number,
  frameWindowY: number,
): number {
  return platform === "ios" ? frameWindowY - frameLocalY : 0;
}
