export const FRAME_MS = 20;
export const GAP_THRESHOLD_MS = 40;

/**
 * Number of silence frames to insert between two packet arrivals so a
 * per-user track keeps the meeting timeline.
 *
 * Gaps at or below `minGapMs` are jitter, not silence: 0. Otherwise the gap is
 * quantized to the nearest whole frame, minus one because the previous packet
 * already covered its own slot. Rounded (not floored): arrivals land off the
 * 20 ms grid, and flooring would swallow up to 19 ms per gap, a systematic
 * early shift over a long meeting. Rounding bounds each gap to +-10 ms with no
 * bias.
 *
 * @param {{ prevAtMs: number, atMs: number, frameMs?: number, minGapMs?: number }} p
 * @returns {number}
 */
export function gapFrames({ prevAtMs, atMs, frameMs = FRAME_MS, minGapMs = GAP_THRESHOLD_MS }) {
  const gap = atMs - prevAtMs;
  if (!(gap > minGapMs)) return 0;
  return Math.max(0, Math.round(gap / frameMs) - 1);
}
