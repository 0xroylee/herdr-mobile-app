export function modalFrameTopInsetClass(platform: string): string {
  return platform === "ios" ? "" : "pt-safe";
}

export function pageSheetKeyboardVerticalOffset(platform: string, topInset: number): number {
  return platform === "ios" ? topInset : 0;
}
