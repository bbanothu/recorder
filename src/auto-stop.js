/** /autostop + AUTO_STOP_MINUTES bounds (minutes). */
export const AUTO_STOP_MIN_MINUTES = 1;
export const AUTO_STOP_MAX_MINUTES = 180;
export const AUTO_STOP_DEFAULT_MINUTES = 5;
export const AUTO_STOP_AFTER_MS = AUTO_STOP_DEFAULT_MINUTES * 60_000;
export const AUTO_STOP_TICK_MS = 15_000;
/** At/below this size an Opus packet is DTX/comfort noise, not voice activity. */
export const AUTO_STOP_ACTIVITY_FLOOR_BYTES = 16;

/**
 * Pure activity check for the auto-stop clock.
 * Floor is deliberately lower than SpeakingGate.minPacketBytes (40): the
 * failsafe must over-count activity — a false "silence" kills a live recording.
 * @param {Buffer | Uint8Array | null | undefined} packet
 * @param {number} [floorBytes]
 */
export function isActivityPacket(packet, floorBytes = AUTO_STOP_ACTIVITY_FLOOR_BYTES) {
  return Boolean(packet && packet.length >= floorBytes);
}

/**
 * Pure auto-stop decision — no I/O, no timers.
 * @param {{
 *   nowMs: number, joinedAtMs: number, lastActivityAtMs: number,
 *   humanCount: number, thresholdMs?: number,
 * }} s
 * @returns {{ stop: boolean, reason: string }}
 */
export function evaluateAutoStop(s) {
  const threshold = s.thresholdMs ?? AUTO_STOP_AFTER_MS;
  if (s.nowMs - s.joinedAtMs < threshold) return { stop: false, reason: '' };
  if (s.humanCount === 0) {
    return { stop: true, reason: `everyone left the voice channel (session ≥ ${threshold / 60_000} min)` };
  }
  if (s.nowMs - s.lastActivityAtMs >= threshold) {
    return { stop: true, reason: `no voice activity for ${Math.round((s.nowMs - s.lastActivityAtMs) / 60_000)} min` };
  }
  return { stop: false, reason: '' };
}
