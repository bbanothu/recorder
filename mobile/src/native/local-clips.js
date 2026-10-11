import { Directory, File, Paths } from 'expo-file-system';
import { chunksOverlapping, parseChunkFileName } from '../core/chunks.js';
import { createClipsStore } from '../core/clips-store.js';
import { openLocalDb } from './sqlite.js';
import { listPending, pendingFile } from './storage.js';

/**
 * Local (server-free) clips: copy the pending minute files a clip range
 * covers into their own folder under <documents>/clips/. Track A has no
 * on-device transcription yet (spec: phone-recorder-on-device.md) — a local
 * clip is just its ordered audio files until Track B adds whisper.rn.
 */

let store = null;
function clipsStore() {
  store ??= createClipsStore(openLocalDb());
  return store;
}

function clipsRoot() {
  const dir = new Directory(Paths.document, 'clips');
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

/**
 * @param {{ fromMs: number, toMs: number }} range
 * @returns {Promise<{ id: number, fromMs: number, toMs: number, dir: string, chunkCount: number, createdAt: string } | null>}
 *   null when nothing in `pending/` overlaps the range (nothing to keep).
 */
export async function buildLocalClip({ fromMs, toMs }) {
  const names = chunksOverlapping(await listPending(), fromMs, toMs);
  if (!names.length) return null;

  const dirName = `${fromMs}-${Date.now()}`;
  const dir = new Directory(clipsRoot(), dirName);
  dir.create({ idempotent: true, intermediates: true });
  for (const name of names) {
    await pendingFile(name).copy(dir);
  }

  const id = clipsStore().createClip({ fromMs, toMs, dir: dirName, chunkCount: names.length });
  return clipsStore().getClip(id);
}

export const listLocalClips = () => clipsStore().listClips();
export const getLocalClip = (id) => clipsStore().getClip(id);

/** Delete one local clip's files and its row. No-op if it's already gone. */
export function deleteLocalClip(id) {
  const clip = clipsStore().getClip(id);
  if (!clip) return;
  new Directory(clipsRoot(), clip.dir).delete();
  clipsStore().deleteClip(id);
}

/** Delete every local clip. */
export function deleteAllLocalClips() {
  for (const clip of clipsStore().listClips()) deleteLocalClip(clip.id);
}

/** Ordered `{ name, startedAt, durationMs, uri }` for every file in a local clip. */
export function localClipFiles(clip) {
  const dir = new Directory(clipsRoot(), clip.dir);
  return dir
    .list()
    .filter((e) => e instanceof File && parseChunkFileName(e.name))
    .map((f) => ({ name: f.name, ...parseChunkFileName(f.name), uri: f.uri }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * How much on-device storage a clip actually uses right now: every
 * `<startedAt>-<durationMs>.m4a` counts as audio, anything else in its
 * folder (`.segments.json` sidecars, a manual edit override) counts as
 * text — same split the server reports for its own clips.
 */
export function localClipSizes(clip) {
  const dir = new Directory(clipsRoot(), clip.dir);
  let audioSizeBytes = 0;
  let textSizeBytes = 0;
  for (const e of dir.list()) {
    if (!(e instanceof File)) continue;
    if (parseChunkFileName(e.name)) audioSizeBytes += e.size;
    else textSizeBytes += e.size;
  }
  return { audioSizeBytes, textSizeBytes };
}
