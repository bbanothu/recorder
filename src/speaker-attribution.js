/**
 * Speaker attribution on a single mixed recording (spec D5). The notetaker
 * hears one mixed stream, so Whisper's segments carry no speaker; the
 * platform's live captions say who spoke when. Pure: no I/O.
 *
 * The caption log is every observed change `{ t, id, name, text }` (absolute
 * ms). Only GROWTH of an entry is evidence of speech: Meet keeps rewording
 * and trimming an entry long after its speaker stopped (entries were seen
 * changing for 15+ min), so an entry's first-to-last lifetime is not a
 * speaking span.
 */

const NEAREST_MS = 10_000;

/**
 * @param {Array<{ t: number, id: string, name: string, text: string }>} log in time order
 * @returns {Array<{ name: string, t: number, weight: number }>} weight = characters added
 */
export function speechEventsFromCaptionLog(log) {
  const lengths = new Map();
  const events = [];
  for (const e of log) {
    const before = lengths.get(e.id) ?? 0;
    const after = (e.text ?? '').length;
    lengths.set(e.id, after);
    if (e.name && after > before) events.push({ name: e.name, t: e.t, weight: after - before });
  }
  return events;
}

/**
 * Give each segment the speaker whose captions grew most between its start
 * and `lagMs` after its end (captions trail the audio). With no growth in
 * that window, the nearest event within 10 s; otherwise `null`.
 * @param {Array<{ start: number, end: number, text: string }>} segments seconds from the recording start
 * @param {Array<{ name: string, t: number, weight: number }>} events
 * @param {{ recordingStartMs: number, lagMs?: number }} opts
 */
export function attributeSegments(segments, events, { recordingStartMs, lagMs = 2500 }) {
  return segments.map((sg) => {
    const a = recordingStartMs + sg.start * 1000;
    const b = recordingStartMs + sg.end * 1000;
    const totals = new Map();
    for (const ev of events) {
      if (ev.t >= a - 500 && ev.t <= b + lagMs) totals.set(ev.name, (totals.get(ev.name) ?? 0) + ev.weight);
    }
    let speaker = null;
    let best = 0;
    for (const [name, w] of totals) {
      if (w > best) [speaker, best] = [name, w];
    }
    if (speaker == null) {
      let nearest = NEAREST_MS;
      for (const ev of events) {
        const d = ev.t < a ? a - ev.t : ev.t > b ? ev.t - b : 0;
        if (d <= nearest) [speaker, nearest] = [ev.name, d];
      }
    }
    return { ...sg, speaker };
  });
}

/**
 * Group attributed segments into the `tracks[]` shape that
 * renderCombinedTranscriptMarkdown consumes. Every track starts at the
 * recording start, so segment times stay on the meeting clock.
 * @param {Array<{ start: number, end: number, text: string, speaker: string | null }>} attributed
 * @param {{ recordingStartMs: number, language?: string | null }} opts
 */
export function tracksFromAttributed(attributed, { recordingStartMs, language = null }) {
  const bySpeaker = new Map();
  for (const { speaker, ...sg } of attributed) {
    if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, []);
    bySpeaker.get(speaker).push(sg);
  }
  return [...bySpeaker].map(([displayName, segments]) => ({
    displayName,
    startedAtMs: recordingStartMs,
    segments,
    language,
  }));
}

/**
 * Fallback transcript straight from the captions (Whisper missing or failed).
 * @param {Array<{ name: string, text: string, firstMs: number, lastMs: number }>} captions
 * @param {{ recordingStartMs: number }} opts
 */
export function tracksFromCaptions(captions, { recordingStartMs }) {
  const attributed = captions
    .filter((c) => (c.text ?? '').trim())
    .map((c) => ({
      start: Math.max(0, Math.round((c.firstMs - recordingStartMs) / 1000)),
      end: Math.max(0, Math.round((c.lastMs - recordingStartMs) / 1000)),
      text: c.text.trim(),
      speaker: c.name || null,
    }));
  return tracksFromAttributed(attributed, { recordingStartMs });
}

/**
 * Final state of each caption entry from the change log, in first-seen order.
 * @param {Array<{ t: number, id: string, name: string, text: string }>} log
 */
export function finalCaptions(log) {
  const byId = new Map();
  for (const e of log) {
    const prev = byId.get(e.id);
    byId.set(e.id, { id: e.id, name: e.name, text: e.text, firstMs: prev?.firstMs ?? e.t, lastMs: e.t });
  }
  return [...byId.values()];
}

/**
 * Transcript tracks for one meeting: Whisper's segments with caption-based
 * speakers, or the captions alone when Whisper produced no text.
 * @param {{
 *   segments: Array<{ start: number, end: number, text: string }> | null,
 *   language?: string | null,
 *   captionLog: Array<{ t: number, id: string, name: string, text: string }>,
 *   recordingStartMs: number,
 * }} p
 */
export function buildMeetingTracks({ segments, language = null, captionLog, recordingStartMs }) {
  if ((segments ?? []).some((s) => (s.text ?? '').trim())) {
    const attributed = attributeSegments(segments, speechEventsFromCaptionLog(captionLog), { recordingStartMs });
    return tracksFromAttributed(attributed, { recordingStartMs, language });
  }
  return tracksFromCaptions(finalCaptions(captionLog), { recordingStartMs });
}
