import { Directory, File, Paths } from 'expo-file-system';
import { TurboModuleRegistry } from 'react-native';
import { floatToInt16Pcm, pcmToWav } from '../core/wav.js';
import { sidecarName } from '../core/transcription-queue.js';
import { runTranscriptionQueue } from '../core/transcription-queue.js';
import { needsTranscription, renderClipMarkdown, transcriptionProgress } from '../core/local-transcript.js';
import { localClipFiles } from './local-clips.js';

/**
 * On-device transcription (spec: phone-recorder-on-device.md, Track B).
 * Needs a custom dev-client build — whisper.rn and react-native-audio-api
 * are native modules, not part of Expo Go (`npx expo prebuild` then
 * `expo run:ios`/`expo run:android`).
 *
 * Confirmed against each library's own source in mobile/node_modules (not
 * guessed, not just docs — this session has no simulator/emulator to run
 * either on, so reading their actual installed types was the next best
 * thing):
 *   - whisper.rn (NativeRNWhisper.ts): initWhisper({ filePath }) → ctx;
 *     ctx.transcribe(wavPath, opts) → { promise } → { result, language,
 *     segments: [{ text, t0, t1 }], isAborted }. t0/t1 are centiseconds
 *     (whisper.cpp convention), relative to the wav.
 *   - react-native-audio-api (core/AudioDecoder.ts, core/AudioBuffer.d.ts):
 *     decodeAudioData(uri: string, sampleRate?: number) → Promise<AudioBuffer>
 *     — accepts a local file:// URI directly (decodeFromLocalFile) and
 *     resamples to `sampleRate` during decode; AudioBuffer.getChannelData(0)
 *     → Float32Array (Web Audio's -1..1 range).
 */

const WHISPER_SAMPLE_RATE = 16000;

/**
 * Are the native modules on-device transcription needs actually in this
 * build? Probed through TurboModuleRegistry.get, which returns null when a
 * module isn't linked — the same call both libraries use internally
 * (react-native-audio-api/src/specs/NativeAudioAPIModule.ts,
 * whisper.rn/src/NativeRNWhisper.ts).
 *
 * Importing the packages to find out is NOT safe: react-native-audio-api
 * does `export default new AudioAPIModule()` and its constructor throws
 * `AudioApiError: ... native module could not be found` at module
 * evaluation. Under Metro's async require that surfaced as an *uncaught*
 * error (importAll → tryCallOne) that a try/catch around the dynamic
 * import didn't reliably contain — it took the app down rather than
 * failing one chunk. Probing first means we never evaluate that module in
 * a build that can't support it.
 */
export function nativeTranscriptionAvailable() {
  try {
    return Boolean(TurboModuleRegistry.get('AudioAPIModule') && TurboModuleRegistry.get('RNWhisper'));
  } catch {
    return false;
  }
}

const MODEL_NAME = 'ggml-tiny.en.bin';
// ggerganov/whisper.cpp's own model release — not bundled in the app; downloaded on request.
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;

function modelFile() {
  return new File(Paths.document, MODEL_NAME);
}

export function hasModel() {
  return modelFile().exists;
}

export async function downloadModel() {
  await File.downloadFileAsync(MODEL_URL, modelFile());
}

const NO_DEV_CLIENT = 'On-device transcription needs a dev-client build (npx expo prebuild), not Expo Go';

let ctxPromise = null;
function whisperContext() {
  // whisper.rn is required lazily, here, for the same reason
  // react-native-audio-api is below: nothing that can throw on a build
  // without the native modules should run at import time. Callers only
  // reach this past nativeTranscriptionAvailable().
  ctxPromise ??= (async () => {
    const { initWhisper } = require('whisper.rn');
    return initWhisper({ filePath: modelFile().uri });
  })().catch((err) => {
    ctxPromise = null; // let a later, real attempt (post-build) retry instead of caching the failure
    throw new Error(`${NO_DEV_CLIENT}: ${err?.message ?? err}`);
  });
  return ctxPromise;
}

/**
 * Decode one chunk's AAC/M4A to a 16-bit PCM WAV whisper.rn can read, under
 * Paths.cache (not the clip dir — this is scratch, not part of the clip).
 *
 * react-native-audio-api is required lazily, right here, rather than
 * imported at the top: it does `export default new AudioAPIModule()` and
 * that constructor throws when the native binding is missing. Deferring it
 * to this one call site — which only runs past
 * nativeTranscriptionAvailable() — keeps a build that can't support it
 * from ever evaluating the module.
 *
 * @returns {Promise<string>} the wav file's uri
 */
async function decodeAacToWav(name, clipDir) {
  let decodeAudioData;
  try {
    ({ decodeAudioData } = require('react-native-audio-api'));
  } catch (err) {
    throw new Error(`${NO_DEV_CLIENT}: ${err?.message ?? err}`);
  }
  const srcUri = new File(clipDir, name).uri;
  const buffer = await decodeAudioData(srcUri, WHISPER_SAMPLE_RATE);
  const pcm = floatToInt16Pcm(buffer.getChannelData(0));
  const wav = pcmToWav(pcm, { sampleRate: WHISPER_SAMPLE_RATE, channels: 1 });
  const wavFile = new File(Paths.cache, `${name}.wav`);
  wavFile.create({ overwrite: true });
  wavFile.write(wav);
  return wavFile.uri;
}

async function transcribeWav(wavUri) {
  const ctx = await whisperContext();
  const { promise } = ctx.transcribe(wavUri, {});
  const { language, segments } = await promise;
  return { language, segments: segments.map((s) => ({ text: s.text, t0: s.t0, t1: s.t1 })) };
}

function clipDir(clip) {
  return new Directory(new Directory(Paths.document, 'clips'), clip.dir);
}

function sidecarFile(clipDir_, chunkName) {
  return new File(clipDir_, sidecarName(chunkName));
}

/** Read every sidecar that exists for a clip's chunks right now (no IO for ones that don't). */
function readSidecars(clip) {
  const dir = clipDir(clip);
  return localClipFiles(clip).map((f) => {
    const sf = sidecarFile(dir, f.name);
    return { ...f, sidecar: sf.exists ? JSON.parse(sf.textSync()) : null };
  });
}

const EDITED_NAME = 'edited.md';

/**
 * Current transcript markdown + progress for a clip. A saved manual edit —
 * or the frozen snapshot deleteLocalClipAudio leaves behind once there's no
 * audio left to regenerate from — always wins over the live sidecar render.
 */
export function getClipTranscript(clip) {
  const chunks = readSidecars(clip);
  const progress = transcriptionProgress(chunks);
  const edited = new File(clipDir(clip), EDITED_NAME);
  if (edited.exists) return { markdown: edited.textSync(), progress };
  if (!chunks.length) return { markdown: null, progress };
  return { markdown: renderClipMarkdown({ fromMs: clip.fromMs, toMs: clip.toMs, chunks }), progress };
}

/** Save a manual edit. Overrides the live sidecar render from now on (see getClipTranscript). */
export function updateLocalClipTranscript(clip, markdown) {
  const f = new File(clipDir(clip), EDITED_NAME);
  f.create({ overwrite: true });
  f.write(markdown);
}

/** Sidecars + any manual edit gone; chunk audio untouched — same chunks will queue again on the next transcribeClip. */
function clearLocalTranscript(clip) {
  const dir = clipDir(clip);
  for (const name of localClipFiles(clip).map((f) => f.name)) {
    const sf = sidecarFile(dir, name);
    if (sf.exists) sf.delete();
  }
  const edited = new File(dir, EDITED_NAME);
  if (edited.exists) edited.delete();
}

/** Delete a local clip's transcript — sidecars and any manual edit. Audio stays; it'll re-transcribe on the next attempt. */
export function deleteLocalClipTranscript(clip) {
  clearLocalTranscript(clip);
}

/** Clear the transcript, then transcribe again right away — discards any manual edit, same as the server's redo. */
export async function redoLocalClip(clip) {
  clearLocalTranscript(clip);
  await transcribeClip(clip);
}

/**
 * Delete a local clip's audio. Freezes whatever transcript exists right now
 * into a manual-edit override first — once the audio's gone there's nothing
 * left to regenerate from — then removes the chunk files and their
 * now-redundant sidecars.
 */
export function deleteLocalClipAudio(clip) {
  const { markdown } = getClipTranscript(clip);
  updateLocalClipTranscript(clip, markdown);
  const dir = clipDir(clip);
  for (const f of localClipFiles(clip)) {
    const sf = sidecarFile(dir, f.name);
    if (sf.exists) sf.delete();
    new File(f.uri).delete();
  }
}

/**
 * Transcribe every chunk in a local clip that isn't done yet, in order,
 * resuming for free after an app kill (transcription-queue.js). A chunk
 * whose last attempt *failed* is not done — needsTranscription retries it,
 * so a stale "native module could not be found" (from before a dev-client
 * build existed) doesn't sit there forever once the real fix is in place.
 * Fire-and-forget from the caller; errors per chunk land in that chunk's
 * sidecar rather than throwing.
 */
export async function transcribeClip(clip) {
  // No native modules in this build (Expo Go): do nothing at all rather
  // than write a "failed" sidecar per chunk. The server path handles
  // transcription here, and a build that gains the native modules later
  // finds these chunks untouched and transcribes them for real.
  if (!nativeTranscriptionAvailable()) return;
  if (!hasModel()) throw new Error('No local transcription model yet — download one in Settings first');
  const dir = clipDir(clip);
  const names = localClipFiles(clip).map((f) => f.name);
  await runTranscriptionQueue(names, {
    exists: async (sidecar) => {
      const f = new File(dir, sidecar);
      return f.exists && !needsTranscription(JSON.parse(f.textSync()));
    },
    decode: async (name) => decodeAacToWav(name, dir),
    transcribe: transcribeWav,
    writeSidecar: async (sidecar, data) => {
      const f = new File(dir, sidecar);
      f.create({ overwrite: true });
      f.write(JSON.stringify(data));
    },
  });
}
