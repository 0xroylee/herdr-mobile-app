export const TAB_BAR_ITEM_VERTICAL_PADDING = 5;
export const TAB_BAR_ICON_HEIGHT = 23;
export const TAB_BAR_LABEL_MARGIN_TOP = 4;
export const TAB_BAR_LABEL_LINE_HEIGHT = 13;

export interface TabBarLayout {
  height: number;
  labelLineHeight: number;
}

export function calculateTabBarLayout(
  fontScale: number,
  bottomInset: number,
  borderTopWidth: number,
): TabBarLayout {
  const scaledLineHeight = TAB_BAR_LABEL_LINE_HEIGHT * Math.max(1, fontScale);
  const itemHeight =
    TAB_BAR_ITEM_VERTICAL_PADDING * 2 +
    TAB_BAR_ICON_HEIGHT +
    TAB_BAR_LABEL_MARGIN_TOP +
    scaledLineHeight;

  return {
    height: Math.ceil(itemHeight + borderTopWidth) + bottomInset,
    labelLineHeight: TAB_BAR_LABEL_LINE_HEIGHT,
  };
}
