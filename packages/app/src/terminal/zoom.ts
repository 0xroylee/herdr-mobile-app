export const MIN_ZOOM = 8;
export const MAX_ZOOM = 16;
export const DEFAULT_ZOOM = 10.6;

const CELL_WIDTH_PER_FONT_SIZE = 0.6;
const DEFAULT_LINE_HEIGHT_RATIO = 16.4 / DEFAULT_ZOOM;
const DEFAULT_ZOOM_RANGE: ZoomRange = { min: MIN_ZOOM, max: MAX_ZOOM };
const DOUBLE_TAP_TOLERANCE = 0.05;

export interface ZoomRange {
  readonly min: number;
  readonly max: number;
}

export interface TerminalCellSize {
  readonly fontSize: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalFit {
  cols: number;
  rows: number;
}

export function overviewZoom(viewportWidth: number, cols: number): number {
  if (
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(cols) ||
    cols <= 0
  ) {
    return MIN_ZOOM;
  }
  return Math.min(MAX_ZOOM, viewportWidth / (cols * CELL_WIDTH_PER_FONT_SIZE));
}

export function zoomRangeForGrid(viewportWidth: number, cols: number): ZoomRange {
  return {
    min: Math.min(MIN_ZOOM, overviewZoom(viewportWidth, cols)),
    max: MAX_ZOOM,
  };
}

export function clampZoom(zoom: number, range: ZoomRange = DEFAULT_ZOOM_RANGE): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : DEFAULT_ZOOM;
  return Math.max(range.min, Math.min(range.max, finiteZoom));
}

export function zoomFromPinch(
  startZoom: number,
  scale: number,
  range: ZoomRange = DEFAULT_ZOOM_RANGE,
): number {
  return clampZoom(clampZoom(startZoom, range) * scale, range);
}

export function doubleTapZoom(currentZoom: number, viewportWidth: number, cols: number): number {
  const range = zoomRangeForGrid(viewportWidth, cols);
  const overview = overviewZoom(viewportWidth, cols);
  if (
    overview < DEFAULT_ZOOM &&
    Math.abs(clampZoom(currentZoom, range) - overview) <= DOUBLE_TAP_TOLERANCE
  ) {
    return clampZoom(DEFAULT_ZOOM, range);
  }
  return clampZoom(Math.min(overview, DEFAULT_ZOOM), range);
}

export function readableFitZoom(zoom: number, range: ZoomRange = DEFAULT_ZOOM_RANGE): number {
  return clampZoom(Math.max(MIN_ZOOM, clampZoom(zoom, range)));
}

export function resetZoom(): number {
  return DEFAULT_ZOOM;
}

export function cellSizeForZoom(
  zoom: number,
  range: ZoomRange = DEFAULT_ZOOM_RANGE,
): TerminalCellSize {
  const fontSize = clampZoom(zoom, range);
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

export function scrollOffsetToBottom(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}
