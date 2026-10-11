/**
 * Pure chunk bookkeeping for the phone app (no React Native imports, so the
 * repo's `node --test` covers it). A chunk file is `<startedAtMs>-<durationMs>.m4a`.
 */

const MIN = 60_000;
const NAME_RE = /^(\d+)-(\d+)\.m4a$/;

/** Window choices offered in the app (minutes). */
export const WINDOW_CHOICES = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 720, label: '12 hours' },
];

/** Clip presets: last N minutes, or the whole window. */
export const CLIP_CHOICES = [
  { value: 5, label: 'Last 5 min' },
  { value: 15, label: 'Last 15 min' },
  { value: 30, label: 'Last 30 min' },
  { value: 'all', label: 'Everything kept' },
];

export function chunkFileName(startedAt, durationMs) {
  return `${startedAt}-${durationMs}.m4a`;
}

/** @returns {{ startedAt: number, durationMs: number } | null} */
export function parseChunkFileName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const startedAt = Number(m[1]);
  const durationMs = Number(m[2]);
  return startedAt > 0 && durationMs > 0 ? { startedAt, durationMs } : null;
}

/** Chunk file names to upload, oldest first. */
export function uploadOrder(names) {
  return names
    .filter((n) => parseChunkFileName(n))
    .sort((a, b) => parseChunkFileName(a).startedAt - parseChunkFileName(b).startedAt);
}

/** Chunk file names whose [startedAt, startedAt+durationMs) intersects [fromMs, toMs), oldest first. */
export function chunksOverlapping(names, fromMs, toMs) {
  return uploadOrder(names).filter((n) => {
    const c = parseChunkFileName(n);
    return c.startedAt < toMs && c.startedAt + c.durationMs > fromMs;
  });
}

/** Pending chunks that ended before `now − window`: deleted on the phone, never uploaded. */
export function expiredChunkNames(names, nowMs, windowMinutes) {
  const cutoff = nowMs - windowMinutes * MIN;
  return uploadOrder(names).filter((n) => {
    const c = parseChunkFileName(n);
    return c.startedAt + c.durationMs < cutoff;
  });
}

/**
 * Time range for a clip preset, capped at the window (older audio is gone).
 * @param {number | 'all'} preset minutes
 */
export function clipRange(preset, nowMs, windowMinutes) {
  const minutes = preset === 'all' ? windowMinutes : Math.min(preset, windowMinutes);
  return { fromMs: nowMs - minutes * MIN, toMs: nowMs };
}
