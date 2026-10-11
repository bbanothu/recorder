import { formatClock, escapeMarkdownName } from './transcribe.js';

const LIFECYCLE = new Set(['join', 'leave', 'reconnect']);

/**
 * Parse a `timeline-<stamp>.jsonl` body (written by Recorder, v3.0.2 D4).
 * Per-line try/catch: a corrupt or unknown line is skipped, never thrown.
 * Per-burst `speech` events are intentionally not returned (nothing consumes
 * them; they stay in the file for the operator).
 * @returns {{t0: number|null, tracks: Array<{userId: string, displayName: string|null, file: string, t: number, deltaMs: number}>, lifecycles: Array<object>} | null}
 *   null for empty/absent input.
 */
export function readTimeline(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let t0 = null;
  const tracks = [];
  const lifecycles = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'session') {
        if (Number.isFinite(ev.t0)) t0 = ev.t0;
      } else if (ev?.type === 'track') {
        tracks.push({
          userId: ev.userId,
          displayName: ev.displayName ?? null,
          file: ev.file,
          t: ev.t,
          deltaMs: ev.deltaMs,
        });
      } else if (LIFECYCLE.has(ev?.type)) {
        lifecycles.push(ev);
      }
    } catch {
      /* corrupt line: skip */
    }
  }
  return { t0, tracks, lifecycles };
}

/**
 * One coverage note per display name that spans more than one track. The time
 * is the meeting-relative start of the name's latest track.
 * @returns {string[]}
 */
export function rejoinNotes(timeline) {
  if (!timeline) return [];
  const byName = new Map();
  for (const tr of timeline.tracks) {
    if (tr.displayName == null) continue;
    if (!byName.has(tr.displayName)) byName.set(tr.displayName, []);
    byName.get(tr.displayName).push(tr);
  }
  const notes = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const latest = Math.max(...list.map((t) => (Number.isFinite(t.deltaMs) ? t.deltaMs : 0)));
    notes.push(
      `_${escapeMarkdownName(name)}: ${list.length} tracks in this meeting (left and rejoined at ${formatClock(latest / 1000)}); lines are merged under one label._`,
    );
  }
  return notes;
}
