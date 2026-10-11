import { basename } from 'node:path';
import { promises as fsp } from 'node:fs';
import { logEvent } from './log.js';
import { renderCombinedTranscriptMarkdown, combinedTranscriptFileName } from './transcribe.js';

/**
 * Source-agnostic transcript pipeline: audio tracks in, one speaker-attributed
 * `transcript-<TS>.md` out. The Discord controller (bot.js) and the invite
 * notetaker (src/notetaker/) both feed it; neither the platform nor the
 * delivery channel is known here.
 */

/**
 * Run the sidecar over every target and keep the fulfilled results.
 * A failing track is logged and dropped (Decision 6): the caller decides what
 * an empty result means.
 * @param {{
 *   targets: Array<{ path: string, displayName: string | null, startedAtMs: number | null }>,
 *   transcribe: (opts: object) => Promise<{ segments?: object[], language?: string | null }>,
 *   transcribeOpts?: object,
 *   log?: (message: string) => void,
 * }} p
 * @returns {Promise<Array<{ displayName: string | null, startedAtMs: number | null, file: string, segments: object[], language: string | null }>>}
 */
export async function transcribeTargets({ targets, transcribe, transcribeOpts = {}, log = logEvent }) {
  // Sidecar entry param name STAYS masterPath (1.6.0 contract) — any audio
  // path rides it; the queue serializes runs anyway.
  const settled = await Promise.allSettled(
    targets.map((t) => transcribe({ ...transcribeOpts, masterPath: t.path })),
  );
  const tracks = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      tracks.push({
        displayName: targets[i].displayName,
        startedAtMs: targets[i].startedAtMs,
        file: basename(targets[i].path),
        segments: s.value?.segments ?? [],
        language: s.value?.language ?? null,
      });
    } else {
      log(
        `transcription failed for ${basename(targets[i].path)} (${s.reason?.message ?? s.reason}); audio already delivered`,
      );
    }
  }
  for (const t of tracks) {
    const n = t.segments.length;
    log(
      n > 0
        ? `transcribed ${t.file}: ${n} segments`
        : `no speech recognized in ${t.file} (0 segments) — audio kept`,
    );
  }
  return tracks;
}

/**
 * Render the combined transcript and write it beside the session, named from
 * the session stamp (Date form = sessionDir's UTC stamp shape).
 * @param {{
 *   dir: string,
 *   sessionStartMs: number,
 *   tracks: object[],
 *   rejoinNotes?: string[],
 *   writeFile?: (path: string, data: string, encoding: string) => Promise<unknown>,
 * }} p
 * @returns {Promise<{ mdPath: string, segmentCount: number, withSpeech: number }>}
 */
export async function writeTranscript({ dir, sessionStartMs, tracks, rejoinNotes = [], writeFile = fsp.writeFile }) {
  const mdPath = combinedTranscriptFileName(dir, new Date(sessionStartMs));
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs,
    tracks,
    coverage: { rejoinNotes },
    sourceFile: dir,
  });
  await writeFile(mdPath, md, 'utf8');
  const segmentCount = tracks.reduce((n, t) => n + t.segments.length, 0);
  const withSpeech = tracks.filter((t) => t.segments.some((sg) => (sg.text ?? '').trim())).length;
  return { mdPath, segmentCount, withSpeech };
}
