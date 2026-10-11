/**
 * Renders a local clip's transcript markdown from whatever per-chunk
 * sidecars currently exist (spec: phone-recorder-on-device.md, Track B).
 * There is no clip-level "pending"/"ready" state: reading a clip's
 * transcript is "stitch whatever sidecars exist right now," which fills in
 * live as mobile/src/core/transcription-queue.js works through the clip.
 *
 * A sidecar is `{ language, segments: [{ text, t0, t1 }] } | { error: string } | null`
 * (null = not transcribed yet). `t0`/`t1` are centiseconds from whisper.rn
 * (whisper.cpp convention), relative to the start of that chunk's own audio.
 */

/**
 * `clip_MM-DD-YYYY_HHMM-HHMM-UTC.md` — same convention as the server's
 * src/transcribe.js clipTranscriptFileName (kept independent, not imported:
 * this package can't reach outside mobile/, see mobile/src/core/wav.js for
 * the same reasoning). Used for the file a clip's transcript shares/
 * downloads as, so it reads the same way wherever it ends up.
 */
export function clipTranscriptFileName(fromMs, toMs) {
  const p = (n) => String(n).padStart(2, '0');
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const date = `${p(from.getUTCMonth() + 1)}-${p(from.getUTCDate())}-${from.getUTCFullYear()}`;
  const clock = (d) => `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `clip_${date}_${clock(from)}-${clock(to)}-UTC.md`;
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** @param {{ fromMs: number, toMs: number, chunks: Array<{ startedAt: number, durationMs: number, sidecar: object | null }> }} clip */
export function renderClipMarkdown({ fromMs, toMs, chunks }) {
  const sorted = [...chunks].sort((a, b) => a.startedAt - b.startedAt);
  const language = sorted.find((c) => c.sidecar?.language)?.sidecar?.language ?? 'unknown';
  const header = `# Clip transcript\n_language: ${language}_\n`;

  const notes = [];
  const lines = [];
  for (const chunk of sorted) {
    const { sidecar, startedAt } = chunk;
    if (sidecar == null) {
      notes.push(`_Segment at ${formatClock((startedAt - fromMs) / 1000)} not transcribed yet._`);
      continue;
    }
    if (sidecar.error) {
      notes.push(`_Segment at ${formatClock((startedAt - fromMs) / 1000)} transcription failed: ${sidecar.error}_`);
      continue;
    }
    const segments = (sidecar.segments ?? []).filter((s) => (s.text ?? '').trim());
    if (!segments.length) {
      notes.push(`_No speech recognized for the segment at ${formatClock((startedAt - fromMs) / 1000)}._`);
      continue;
    }
    for (const seg of segments) {
      const absMs = startedAt + seg.t0 * 10;
      if (absMs < fromMs || absMs >= toMs) continue;
      lines.push(`[${formatClock((absMs - fromMs) / 1000)}] ${seg.text.trim()}`);
    }
  }
  const noteBlock = notes.length ? `${notes.join('\n\n')}\n` : '';
  return `${header}\n${noteBlock}\n${lines.join('\n\n')}\n`;
}

/**
 * True when a chunk should be (re)transcribed: no attempt yet, or the last
 * one failed. A failure is never terminal — the queue should keep trying on
 * every subsequent transcribeClip() call (app relaunch, a later Clip, the
 * cause of the failure getting fixed) instead of a bad sidecar permanently
 * freezing that segment's error message in place.
 */
export function needsTranscription(sidecar) {
  return sidecar == null || sidecar.error != null;
}

/** How many of a clip's chunks have a sidecar yet (done, including failed) vs the total. */
export function transcriptionProgress(chunks) {
  return { done: chunks.filter((c) => c.sidecar != null).length, total: chunks.length };
}
