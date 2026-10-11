import { mkdir, writeFile, rename, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logEvent } from '../log.js';
import { renderCombinedTranscriptMarkdown, clipTranscriptFileName } from '../transcribe.js';

/**
 * Phone recorder service (spec .project/specs/phone-recorder.md): chunk
 * intake, a serial Whisper queue, retroactive clips and the retention sweep.
 * Files: `<root>/<deviceId>/chunks/<startedAt>.m4a` (+ `.segments.json`) and
 * `<root>/<deviceId>/clips/<id>/`. Clock, transcriber and audio concat are
 * injected.
 */

// The id becomes a directory name: keep it to a safe alphabet.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CLIP_MS = 24 * 60 * 60_000;
const MAX_CHUNK_MS = 2 * 60 * 60_000;

/** Byte size of a file, or 0 if it doesn't exist (never throws — paths are often null/stale). */
async function fileSize(path) {
  if (!path) return 0;
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw badRequest(`Invalid deviceId: ${deviceId} (1-64 of A-Z a-z 0-9 _ -)`);
  }
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createPhoneStore>,
 *   root: string,
 *   transcribe: (o: { masterPath: string }) => Promise<{ segments?: Array<{ start: number, end: number, text: string }>, language?: string | null }>,
 *   concatAudio: (inputs: string[], out: string) => Promise<unknown>,
 *   now?: () => number,
 *   log?: (m: string) => void,
 * }} deps
 */
export function createPhoneService({ store, root, transcribe, concatAudio, now = Date.now, log = logEvent }) {
  const chunkDir = (deviceId) => join(root, deviceId, 'chunks');
  let queue = Promise.resolve();

  async function transcribeChunk(c) {
    try {
      const res = await transcribe({ masterPath: c.path });
      const segments = (res?.segments ?? [])
        .filter((s) => (s.text ?? '').trim())
        .map((s) => ({
          startMs: Math.round(c.startedAt + s.start * 1000),
          endMs: Math.round(c.startedAt + s.end * 1000),
          text: s.text.trim(),
        }));
      const segmentsPath = c.path.replace(/\.m4a$/, '.segments.json');
      await writeFile(segmentsPath, JSON.stringify({ language: res?.language ?? null, segments }));
      store.setChunkTranscribed(c.deviceId, c.startedAt, segmentsPath);
    } catch (err) {
      log(`phone: transcription failed for ${c.deviceId}/${c.startedAt} (${err?.message ?? err})`);
      store.setChunkFailed(c.deviceId, c.startedAt);
    }
  }

  function enqueue(c) {
    queue = queue.then(() => transcribeChunk(c));
  }

  /**
   * Store one uploaded chunk (atomic write) and queue it for Whisper.
   * @returns {Promise<'created' | 'exists'>}
   */
  async function receiveChunk(deviceId, startedAt, durationMs, body) {
    assertDeviceId(deviceId);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw badRequest(`Invalid startedAt: ${startedAt}`);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_CHUNK_MS) {
      throw badRequest(`Invalid durationMs: ${durationMs}`);
    }
    if (!body?.length) throw badRequest('Chunk body is empty');
    const dir = chunkDir(deviceId);
    const path = join(dir, `${startedAt}.m4a`);
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.part`;
    await writeFile(tmp, body);
    await rename(tmp, path);
    const isNew = store.addChunk({ deviceId, startedAt, durationMs, path });
    if (!isNew) return 'exists';
    enqueue({ deviceId, startedAt, durationMs, path });
    return 'created';
  }

  function setWindow(deviceId, minutes) {
    assertDeviceId(deviceId);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw badRequest(`Invalid windowMinutes: ${minutes} (whole minutes 1-1440)`);
    }
    store.setWindow(deviceId, minutes);
    return minutes;
  }

  /**
   * Ask to keep [fromMs, toMs). Ready once its chunks are transcribed.
   * Every clip is also a retry: any chunk in the range whose transcription
   * failed before goes back in the queue. A failure is never permanent —
   * without this, a chunk that failed once (a whisper hiccup, a bug since
   * fixed) silently contributes nothing to this clip and every later one
   * over the same audio, with no way to ask for another attempt.
   */
  function createClip(deviceId, fromMs, toMs) {
    assertDeviceId(deviceId);
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs || toMs - fromMs > MAX_CLIP_MS) {
      throw badRequest(`Invalid clip range: ${fromMs}..${toMs} (up to 24 h, end after start)`);
    }
    for (const c of store.chunksOverlapping(deviceId, fromMs, toMs)) {
      if (c.state === 'failed' && store.requeueFailedChunk(deviceId, c.startedAt)) {
        log(`phone: retrying transcription for ${deviceId}/${c.startedAt}`);
        enqueue(c);
      }
    }
    return store.createClip({ deviceId, fromMs, toMs });
  }

  async function finalizeClip(clip) {
    const chunks = store.chunksOverlapping(clip.deviceId, clip.fromMs, clip.toMs);
    if (chunks.some((c) => c.state === 'received')) return false; // Whisper still busy
    const segments = [];
    let language = null;
    for (const c of chunks) {
      if (!c.segmentsPath) continue;
      const data = JSON.parse(await readFile(c.segmentsPath, 'utf8'));
      language ??= data.language;
      for (const s of data.segments) {
        if (s.startMs >= clip.fromMs && s.startMs < clip.toMs) segments.push(s);
      }
    }
    const dir = join(root, clip.deviceId, 'clips', String(clip.id));
    await mkdir(dir, { recursive: true });
    const mdPath = clipTranscriptFileName(dir, clip.fromMs, clip.toMs);
    const md = renderCombinedTranscriptMarkdown({
      sessionStartMs: clip.fromMs,
      tracks: [{
        displayName: null,
        startedAtMs: clip.fromMs,
        language,
        segments: segments.map((s) => ({ start: (s.startMs - clip.fromMs) / 1000, end: (s.endMs - clip.fromMs) / 1000, text: s.text })),
      }],
      sourceFile: `clip-${clip.id}`,
    });
    await writeFile(mdPath, md, 'utf8');
    let audioPath = null;
    if (chunks.length) {
      audioPath = join(dir, 'clip.m4a');
      try {
        await concatAudio(chunks.map((c) => c.path), audioPath);
      } catch (err) {
        log(`phone: clip ${clip.id} audio not kept (${err?.message ?? err}); transcript saved`);
        audioPath = null;
      }
    }
    store.finishClip(clip.id, { mdPath, audioPath, language });
    log(`phone: clip ${clip.id} ready (${segments.length} segment(s)) → ${mdPath}`);
    return true;
  }

  /** Finish every pending clip whose chunks are done. Never throws. */
  async function finalizeClips() {
    for (const clip of store.pendingClips()) {
      try {
        await finalizeClip(clip);
      } catch (err) {
        log(`phone: clip ${clip.id} could not be finished yet (${err?.message ?? err})`);
      }
    }
  }

  /**
   * Delete chunks past their device's window, except those a pending clip
   * still needs or that haven't been transcribed yet. A chunk can arrive
   * already stale (a phone uploads whatever backlog it has, hourly or
   * right before a Clip; receiveChunk never rejects an old startedAt) —
   * without the 'received' guard, a slow or merely queued transcription
   * loses the race against the next sweep, which deletes the file out from
   * under it ("Error opening input file ... No such file or directory").
   * Every chunk gets at least one chance to be transcribed before it can
   * be swept. Returns how many were deleted.
   */
  async function sweep() {
    const pending = store.pendingClips();
    let removed = 0;
    for (const c of store.expiredChunks(now())) {
      if (c.state === 'received') continue; // still queued or in flight — give it its chance first
      const end = c.startedAt + c.durationMs;
      if (pending.some((p) => p.deviceId === c.deviceId && c.startedAt < p.toMs && end > p.fromMs)) continue;
      await rm(c.path, { force: true });
      if (c.segmentsPath) await rm(c.segmentsPath, { force: true });
      store.deleteChunk(c.deviceId, c.startedAt);
      removed += 1;
    }
    if (removed) log(`phone: retention removed ${removed} chunk(s)`);
    return removed;
  }

  async function getClip(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.getClip(deviceId, id);
    if (!clip) return null;
    const markdown = clip.mdPath ? await readFile(clip.mdPath, 'utf8') : null;
    const [mdSizeBytes, audioSizeBytes] = await Promise.all([fileSize(clip.mdPath), fileSize(clip.audioPath)]);
    return {
      id: clip.id, fromMs: clip.fromMs, toMs: clip.toMs, state: clip.state, createdAt: clip.createdAt, markdown,
      language: clip.language, hasAudio: Boolean(clip.audioPath), translated: Boolean(clip.translatedMdPath),
      mdSizeBytes, audioSizeBytes,
    };
  }

  async function listClips(deviceId) {
    assertDeviceId(deviceId);
    return Promise.all(
      store.listClips(deviceId).map(async ({ id, fromMs, toMs, state, createdAt, language, mdPath, audioPath }) => {
        const [mdSizeBytes, audioSizeBytes] = await Promise.all([fileSize(mdPath), fileSize(audioPath)]);
        return { id, fromMs, toMs, state, createdAt, language, mdSizeBytes, audioSizeBytes };
      }),
    );
  }

  /**
   * English translation of a clip, via Whisper's own translate task on the
   * clip's kept audio (not a text-translation pass over the existing
   * transcript — Whisper translates directly from audio). Cached in
   * translated_md_path after the first call; an already-English clip reuses
   * its own transcript instead of re-running Whisper for an identity
   * translation.
   * @returns {Promise<{ translatedMarkdown: string } | null>} null if no such clip
   */
  async function translateClip(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.getClip(deviceId, id);
    if (!clip) return null;
    if (clip.state !== 'ready') throw badRequest('Clip is not ready yet');
    if (clip.translatedMdPath) return { translatedMarkdown: await readFile(clip.translatedMdPath, 'utf8') };
    if (clip.language === 'en') {
      const translatedMarkdown = clip.mdPath ? await readFile(clip.mdPath, 'utf8') : '';
      store.setClipTranslation(id, clip.mdPath);
      return { translatedMarkdown };
    }
    if (!clip.audioPath) throw badRequest('This clip has no kept audio to translate');

    const result = await transcribe({ masterPath: clip.audioPath, translate: true });
    const segments = (result?.segments ?? []).filter((s) => (s.text ?? '').trim());
    const dir = join(root, deviceId, 'clips', String(id));
    const translatedPath = join(dir, 'translated-en.md');
    const translatedMarkdown = renderCombinedTranscriptMarkdown({
      sessionStartMs: clip.fromMs,
      tracks: [{
        displayName: null,
        startedAtMs: clip.fromMs,
        language: 'en',
        segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      }],
      sourceFile: `clip-${id}-en`,
    });
    await writeFile(translatedPath, translatedMarkdown, 'utf8');
    store.setClipTranslation(id, translatedPath);
    log(`phone: clip ${id} translated to English`);
    return { translatedMarkdown };
  }

  /**
   * Re-run Whisper's normal transcribe task on the clip's kept audio,
   * overwriting its transcript in place (same file, reused if it already
   * has one). Invalidates a cached translation and any manual edit — redo
   * means start fresh from the audio, not patch what was there.
   * @returns {Promise<{ markdown: string, language: string | null } | null>} null if no such clip
   */
  async function redoClip(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.getClip(deviceId, id);
    if (!clip) return null;
    if (clip.state !== 'ready') throw badRequest('Clip is not ready yet');
    if (!clip.audioPath) throw badRequest('This clip has no kept audio to redo from');

    const result = await transcribe({ masterPath: clip.audioPath });
    const segments = (result?.segments ?? []).filter((s) => (s.text ?? '').trim());
    const language = result?.language ?? null;
    const dir = join(root, deviceId, 'clips', String(id));
    const mdPath = clip.mdPath ?? clipTranscriptFileName(dir, clip.fromMs, clip.toMs);
    const markdown = renderCombinedTranscriptMarkdown({
      sessionStartMs: clip.fromMs,
      tracks: [{
        displayName: null,
        startedAtMs: clip.fromMs,
        language,
        segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      }],
      sourceFile: `clip-${id}`,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(mdPath, markdown, 'utf8');
    store.setClipMdPath(id, mdPath);
    store.setClipLanguage(id, language);
    if (clip.translatedMdPath) {
      // An already-English clip's cached "translation" is just a pointer at
      // its own transcript (translateClip's reuse shortcut) — same file as
      // mdPath. Only delete it when it's a genuinely separate file.
      if (clip.translatedMdPath !== mdPath) await rm(clip.translatedMdPath, { force: true });
      store.setClipTranslation(id, null);
    }
    log(`phone: clip ${id} redone (${segments.length} segment(s))`);
    return { markdown, language };
  }

  /**
   * Overwrite a clip's transcript with user-edited text. Writes to the
   * clip's existing file if it has one, otherwise creates one at the usual
   * path (covers editing right after a deleteClipText) — either way the
   * store always ends up pointing at a real file.
   * @returns {Promise<boolean>} false if no such clip
   */
  async function updateClipMarkdown(deviceId, id, markdown) {
    assertDeviceId(deviceId);
    if (typeof markdown !== 'string') throw badRequest('markdown must be a string');
    const clip = store.getClip(deviceId, id);
    if (!clip) return false;
    const dir = join(root, deviceId, 'clips', String(id));
    const mdPath = clip.mdPath ?? clipTranscriptFileName(dir, clip.fromMs, clip.toMs);
    await mkdir(dir, { recursive: true });
    await writeFile(mdPath, markdown, 'utf8');
    if (!clip.mdPath) store.setClipMdPath(id, mdPath);
    log(`phone: clip ${id} transcript revised`);
    return true;
  }

  /** Delete just a clip's kept audio — transcript (and any translation) stays. @returns {Promise<boolean>} */
  async function deleteClipAudio(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.getClip(deviceId, id);
    if (!clip) return false;
    if (clip.audioPath) await rm(clip.audioPath, { force: true });
    store.setClipAudioPath(id, null);
    log(`phone: clip ${id} audio deleted`);
    return true;
  }

  /** Delete just a clip's transcript (and cached translation) — audio stays. @returns {Promise<boolean>} */
  async function deleteClipText(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.getClip(deviceId, id);
    if (!clip) return false;
    if (clip.mdPath) await rm(clip.mdPath, { force: true });
    if (clip.translatedMdPath) await rm(clip.translatedMdPath, { force: true });
    store.setClipMdPath(id, null);
    store.setClipTranslation(id, null);
    log(`phone: clip ${id} transcript deleted`);
    return true;
  }

  /** @returns {Promise<boolean>} true if a clip was actually deleted */
  async function deleteClip(deviceId, id) {
    assertDeviceId(deviceId);
    const clip = store.deleteClip(deviceId, id);
    if (!clip) return false;
    await rm(join(root, deviceId, 'clips', String(id)), { recursive: true, force: true });
    log(`phone: clip ${id} deleted`);
    return true;
  }

  /** @returns {Promise<number>} how many clips were deleted */
  async function deleteAllClips(deviceId) {
    assertDeviceId(deviceId);
    let removed = 0;
    for (const { id } of store.listClips(deviceId)) {
      if (await deleteClip(deviceId, id)) removed += 1;
    }
    return removed;
  }

  return {
    receiveChunk,
    setWindow,
    createClip,
    finalizeClips,
    sweep,
    getClip,
    listClips,
    deleteClip,
    deleteAllClips,
    translateClip,
    redoClip,
    updateClipMarkdown,
    deleteClipAudio,
    deleteClipText,
    /** Re-queue chunks a restart left untranscribed. */
    resume: () => store.chunksInState('received').forEach(enqueue),
    /** Resolves when the transcription queue is empty (tests, shutdown). */
    idle: () => queue,
  };
}
