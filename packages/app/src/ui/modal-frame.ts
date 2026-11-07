export function modalFrameTopInsetClass(platform: string, isPageSheet = true): string {
  return platform === "ios" && isPageSheet ? "" : "pt-safe";
}

export function startFrameKeyboardPadding(
  platform: string,
  keyboardHeight: number,
  reservedBottomInset: number,
): number {
  return platform === "ios" ? Math.max(keyboardHeight - reservedBottomInset, 0) : 0;
}
