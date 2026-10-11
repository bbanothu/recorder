/** Leave once the bot has been the only participant this long (spec D4). */
export const ALONE_LEAVE_MS = 2 * 60_000;
/** Leave this long after the invite's DTEND. */
export const END_GRACE_MS = 30 * 60_000;
/** Never stay in one call longer than this. */
export const HARD_CAP_MS = 4 * 60 * 60_000;

/**
 * Pure leave decision — no I/O, no timers (the src/auto-stop.js pattern).
 * @param {{
 *   nowMs: number, joinedAtMs: number, endsAtMs: number | null,
 *   inCall: boolean, aloneSinceMs: number | null,
 * }} s
 * @returns {{ leave: boolean, reason: string }}
 */
export function evaluateLeave(s) {
  if (!s.inCall) return { leave: true, reason: 'the bot is no longer in the call (ended, removed or disconnected)' };
  if (s.aloneSinceMs != null && s.nowMs - s.aloneSinceMs >= ALONE_LEAVE_MS) {
    return { leave: true, reason: `the bot was the only participant for ${ALONE_LEAVE_MS / 60_000} min` };
  }
  if (s.endsAtMs != null && s.nowMs >= s.endsAtMs + END_GRACE_MS) {
    return { leave: true, reason: `${END_GRACE_MS / 60_000} min past the scheduled end` };
  }
  if (s.nowMs - s.joinedAtMs >= HARD_CAP_MS) {
    return { leave: true, reason: `reached the ${HARD_CAP_MS / 3_600_000} h cap` };
  }
  return { leave: false, reason: '' };
}

/**
 * Advance the "alone since" clock. `participantCount` includes the bot;
 * `null` means the page could not tell, which never counts as alone.
 * @param {number | null} aloneSinceMs
 * @param {number | null} participantCount
 * @param {number} nowMs
 */
export function nextAloneSince(aloneSinceMs, participantCount, nowMs) {
  if (participantCount == null || participantCount > 1) return null;
  return aloneSinceMs ?? nowMs;
}
