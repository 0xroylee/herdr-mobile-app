export const MIN_ZOOM = 8;
export const MAX_ZOOM = 16;
export const DEFAULT_ZOOM = 10.6;

const CELL_WIDTH_PER_FONT_SIZE = 0.6;
const DEFAULT_LINE_HEIGHT_RATIO = 16.4 / DEFAULT_ZOOM;

export interface TerminalCellSize {
  readonly fontSize: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalFit {
  cols: number;
  rows: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function zoomFromPinch(startZoom: number, scale: number): number {
  return clampZoom(startZoom * scale);
}

export function cellSizeForZoom(zoom: number): TerminalCellSize {
  const fontSize = clampZoom(zoom);
  return {
    fontSize,
    width: Math.round(fontSize * CELL_WIDTH_PER_FONT_SIZE * 1_000) / 1_000,
    height: Math.round(fontSize * DEFAULT_LINE_HEIGHT_RATIO * 1_000) / 1_000,
  };
}

export function gridThatFits(
  viewport: { width: number; height: number },
  zoom: number,
): TerminalFit {
  const cell = cellSizeForZoom(zoom);
  return {
    cols: viewport.width > 0 ? Math.floor(viewport.width / cell.width) : 0,
    rows: viewport.height > 0 ? Math.floor(viewport.height / cell.height) : 0,
  };
}

export function resetZoom(): number {
  return DEFAULT_ZOOM;
}

export function scrollOffsetToBottom(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}
