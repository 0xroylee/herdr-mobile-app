/** Format the elapsed time since a timestamp using the app's compact age labels. */
export function formatAge(timestampMs: number | null | undefined, now: number): string {
  if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return "<1m";
  }

  const elapsedMs = Math.max(0, now - timestampMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsedMs < minute) return "<1m";
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h`;
  return `${Math.floor(elapsedMs / day)}d`;
}
