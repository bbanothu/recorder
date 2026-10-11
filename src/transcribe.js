import { spawn as nodeSpawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { logEvent } from './log.js';
import { fileURLToPath } from 'node:url';

export function formatClock(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${String(h).padStart(2, '0')}:${mmss}` : mmss;
}

/** Escape markdown specials in a display name (Decision 8). */
export function escapeMarkdownName(name) {
  return name.replace(/([\\`*_~[\]()#!<>])/g, '\\$1');
}

/**
 * One chronologically interleaved, speaker-labeled transcript (Task 2).
 * `sessionStartMs` is a REQUIRED explicit input (recorder session-start stamp);
 * the renderer never infers a zero. Meeting time of a segment:
 * `track.startedAtMs + segment.start*1000 − sessionStartMs`, clamped ≥ 0.
 * Order: (absStart, displayName) — ties by name (Decision 3). A track with
 * `displayName: null` renders lines WITHOUT a speaker prefix (the v2.0.0
 * speakerless line shape).
 * v3.0.2 D6: a track carrying `file` and no recognized text is named in a
 * `_No speech recognized for **name** (file)._` note between the header and
 * the entries; `coverage.rejoinNotes` (strings) follow those notes. With no
 * text-less named track and no notes the output is byte-identical to before.
 */
export function renderCombinedTranscriptMarkdown({ sessionStartMs, tracks, language, sourceFile, coverage }) {
  if (typeof sessionStartMs !== 'number' || !Number.isFinite(sessionStartMs)) {
    throw new TypeError('renderCombinedTranscriptMarkdown: sessionStartMs is required (number)');
  }
  const sortedTracks = [...(tracks ?? [])].sort(
    (a, b) => a.startedAtMs - b.startedAtMs
      || String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')),
  );
  // Session-level language: explicit input wins, else first non-null track by startedAtMs (Decision 5).
  const lang = language
    ?? sortedTracks.find((t) => t.language != null)?.language
    ?? null;
  const header = `# Meeting transcript — ${basename(sourceFile)}\n_language: ${lang ?? 'unknown'}_\n`;
  const lines = [];
  const notes = [];
  for (const track of sortedTracks) {
    if (track.file && !(track.segments ?? []).some((sg) => (sg.text ?? '').trim())) {
      const who = track.displayName == null ? 'an unnamed speaker' : `**${escapeMarkdownName(track.displayName)}**`;
      notes.push(`_No speech recognized for ${who} (${track.file})._`);
    }
  }
  notes.push(...(coverage?.rejoinNotes ?? []));
  const noteBlock = notes.length ? `${notes.join('\n\n')}\n` : '';
  for (const track of sortedTracks) {
    const label = track.displayName == null ? null : `**${escapeMarkdownName(track.displayName)}:**`;
    for (const sg of track.segments ?? []) {
      const text = (sg.text ?? '').trim();
      if (!text) continue;
      const absSec = Math.max(0, track.startedAtMs + sg.start * 1000 - sessionStartMs) / 1000;
      // Garbage track.startedAtMs / sg.start must never emit a [NaN:NaN] line.
      if (!Number.isFinite(absSec)) continue;
      lines.push({
        absSec: Math.round(absSec),
        sortName: label ?? '',
        line: label ? `[${formatClock(absSec)}] ${label} ${text}` : `[${formatClock(absSec)}] ${text}`,
      });
    }
  }
  // Ties on rounded time resolve by displayName (Decision 3); stable within a track.
  lines.sort((a, b) => a.absSec - b.absSec || a.sortName.localeCompare(b.sortName));
  if (!lines.length) return `${header}\n_No speech detected._\n${noteBlock ? `\n${noteBlock}` : ''}`;
  // Entries are separated by a BLANK line (v3.0.1): the .md is previewed as
  // markdown by Discord, where a single `\n` is a soft break and collapses
  // consecutive entries into one paragraph. One blank line = one block per entry.
  return `${header}\n${noteBlock ? `${noteBlock}\n` : ''}${lines.map((l) => l.line).join('\n\n')}\n`;
}

/**
 * Combined-transcript output name: `transcript-<ts>.md` inside `dir`.
 * `timestampLike`: a Date (UTC YYYY-MM-DD_HH-MM, matching sessionDir's stamp)
 * or a pre-formatted timestamp string (per-user sessions — the only route left
 * in v3.0.0 — pass dir + session timestamp). Keeps the dir's own separators
 * (pure-string, never join()). REQUIRED: the retired single-arg / master-path
 * form had no remaining caller once the master transcription route went away.
 */
export function combinedTranscriptFileName(dir, timestampLike) {
  const base = dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + (dir.includes('\\') ? '\\' : '/');
  let ts;
  if (timestampLike instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    ts = `${timestampLike.getUTCFullYear()}-${p(timestampLike.getUTCMonth() + 1)}-${p(timestampLike.getUTCDate())}_${p(timestampLike.getUTCHours())}-${p(timestampLike.getUTCMinutes())}`;
  } else {
    // A pre-formatted timestamp string — the only other form left: the
    // per-user route passes the session stamp. The path-like-string form died
    // with the master transcription route, so it is not special-cased anymore.
    ts = String(timestampLike ?? '');
  }
  return `${base}transcript-${ts}.md`;
}

/**
 * Phone-clip transcript filename: `clip_MM-DD-YYYY_HHMM-HHMM-UTC.md` — the
 * clip's date and its whole [fromMs, toMs) range, not just a single start
 * stamp (what combinedTranscriptFileName gives the bot/notetaker). Named by
 * its start date; a clip that happens to cross midnight UTC is rare enough
 * (the window default is far under 24h) that the content's own header,
 * which has the exact range, is where that detail actually lives.
 */
export function clipTranscriptFileName(dir, fromMs, toMs) {
  const base = dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + (dir.includes('\\') ? '\\' : '/');
  const p = (n) => String(n).padStart(2, '0');
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const date = `${p(from.getUTCMonth() + 1)}-${p(from.getUTCDate())}-${from.getUTCFullYear()}`;
  const clock = (d) => `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `${base}clip_${date}_${clock(from)}-${clock(to)}-UTC.md`;
}

const SIDECAR = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/**
 * Decision 7: per-user tracks below this many Opus frames (~2s at 20ms/frame)
 * are skipped before the sidecar — faster-whisper hallucinates on tiny clips.
 * Pinned by the bot.test.mjs near-empty-skip boundary test (99 vs 100).
 */
export const MIN_TRACK_FRAMES = 100;

/** Transient canonical WAV next to the track; swept at startup if a kill leaves it behind. */
export const TRANSCRIBE_TMP_SUFFIX = '.transcribe.tmp.wav';

const DECODE_ERROR_RE = /Error parsing the packet header|Invalid data found/g;

/** ffmpeg argv: any track -> 16 kHz mono s16 WAV (what the sidecar's model consumes). */
export function buildTranscodeArgs(inPath, wavPath) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath];
}

/**
 * Canonicalise a track through ffmpeg (D8): the CLI recovers past an
 * undecodable packet where PyAV does not. Never throws.
 * @returns {Promise<{ ok: boolean, decodeErrors: number, stderrTail: string }>}
 */
export async function transcodeToWav({
  inputPath, wavPath, ffmpegBin = 'ffmpeg', spawnFn = nodeSpawn, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let err = '';
  try {
    const child = spawnFn(ffmpegBin, buildTranscodeArgs(inputPath, wavPath), { windowsHide: true });
    child.stdout?.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`ffmpeg timeout after ${timeoutMs} ms`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    return { ok: code === 0, decodeErrors: (err.match(DECODE_ERROR_RE) ?? []).length, stderrTail: err.slice(-500) };
  } catch (e) {
    return { ok: false, decodeErrors: 0, stderrTail: `${err.slice(-400)} ${e?.message ?? e}`.trim() };
  }
}

export async function runTranscription({
  spawnFn = nodeSpawn, transcodeFn = transcodeToWav, unlinkFn = unlink, log = logEvent,
  pythonBin, model, masterPath, cacheDir, timeoutMs = DEFAULT_TIMEOUT_MS, translate = false,
}) {
  const wavPath = masterPath.slice(0, masterPath.length - extname(masterPath).length) + TRANSCRIBE_TMP_SUFFIX;
  let input = masterPath;
  try {
    const t = await transcodeFn({ inputPath: masterPath, wavPath, spawnFn, timeoutMs });
    if (t?.ok) {
      input = wavPath;
      if (t.decodeErrors > 0) log(`transcribe: ffmpeg recovered ${t.decodeErrors} decode error(s) in ${basename(masterPath)}`);
    } else {
      log(`transcribe: ffmpeg canonicalisation failed for ${basename(masterPath)}; using the raw track (${t?.stderrTail ?? 'no detail'})`);
    }
    return await runSidecar({ spawnFn, pythonBin, model, input, cacheDir, timeoutMs, translate });
  } finally {
    // Best-effort; also covers a failed/partial transcode that left a file.
    try { await unlinkFn(wavPath); } catch { /* ENOENT or already gone */ }
  }
}

async function runSidecar({ spawnFn, pythonBin, model, input, cacheDir, timeoutMs, translate = false }) {
  const args = [SIDECAR, '--input', input, '--model', model];
  if (cacheDir) args.push('--cache-dir', cacheDir);
  if (translate) args.push('--translate');
  const child = spawnFn(pythonBin, args, { windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`transcription timeout after ${timeoutMs} ms`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (code !== 0) throw new Error(`transcribe.py exit ${code}: ${err.slice(-500) || 'no stderr'}`);
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error(`transcribe.py stdout parse failed: ${out.slice(0, 200)}`); }
  return { segments: parsed.segments ?? [], language: parsed.language ?? null };
}

export const defaultPythonBin = () => (process.platform === 'win32' ? 'python' : 'python3');
