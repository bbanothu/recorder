import { appendFileSync } from 'node:fs';

export const TIMELINE_VERSION = 1;

const LIFECYCLE = new Set(['join', 'leave', 'reconnect']);

export function sessionEvent({ t0, guildId, botUserId, dir, version }) {
  return { v: TIMELINE_VERSION, type: 'session', t0, guildId, botUserId, dir, version };
}

export function trackEvent({ userId, displayName, file, t, t0 }) {
  return { v: TIMELINE_VERSION, type: 'track', userId, displayName, file, t, deltaMs: t - t0 };
}

export function speechEvent({ userId, t, trackMs }) {
  return { v: TIMELINE_VERSION, type: 'speech', userId, t, trackMs };
}

/** @param {'join'|'leave'|'reconnect'} kind */
export function lifecycleEvent(kind, { userId, t }) {
  if (!LIFECYCLE.has(kind)) throw new Error(`Unknown timeline lifecycle kind: ${kind}`);
  return { v: TIMELINE_VERSION, type: kind, userId, t };
}

export function endEvent({ t, t0, durationMs }) {
  return { v: TIMELINE_VERSION, type: 'end', t, t0, durationMs };
}

/**
 * Append one JSON line. Never throws (it runs inside the voice-data callback):
 * returns false on failure and reports the error through `onError`.
 * @returns {boolean}
 */
export function appendTimelineEvent(path, event, onError) {
  try {
    appendFileSync(path, `${JSON.stringify(event)}\n`);
    return true;
  } catch (err) {
    try {
      onError?.(err);
    } catch {
      /* reporting must not throw either */
    }
    return false;
  }
}
