/**
 * Resumable, serial, per-clip transcription queue (spec:
 * phone-recorder-on-device.md, Track B). Resumability is the filesystem: a
 * chunk's sidecar existing *is* "done" — there is no separate queue table,
 * so an app kill mid-clip just resumes by re-scanning the same directory.
 * All IO is injected (same DI convention as src/phone/service.js) so the
 * ordering/skip/error-handling logic here runs under `node --test`; only
 * the leaf `decode`/`transcribe` calls are native (mobile/src/native/
 * ondevice-transcribe.js) and untested in this environment.
 */

export function sidecarName(chunkName) {
  return chunkName.replace(/\.m4a$/, '.segments.json');
}

/**
 * @param {string[]} names chunk file names, in the order to transcribe them
 * @param {{
 *   exists: (sidecarName: string) => Promise<boolean>,
 *   decode: (name: string) => Promise<string>,            name -> wav path
 *   transcribe: (wavPath: string) => Promise<object>,      wav path -> sidecar data
 *   writeSidecar: (sidecarName: string, data: object) => Promise<void>,
 *   onProgress?: (e: { name: string, status: 'start' | 'done' | 'failed', error?: Error }) => void,
 * }} deps
 */
export async function runTranscriptionQueue(names, { exists, decode, transcribe, writeSidecar, onProgress }) {
  for (const name of names) {
    const sidecar = sidecarName(name);
    if (await exists(sidecar)) continue; // already done
    onProgress?.({ name, status: 'start' });
    try {
      const wavPath = await decode(name);
      const data = await transcribe(wavPath);
      await writeSidecar(sidecar, data);
      onProgress?.({ name, status: 'done' });
    } catch (err) {
      // Don't let one bad chunk stop the rest: record the failure and move on.
      await writeSidecar(sidecar, { error: err?.message ?? String(err) });
      onProgress?.({ name, status: 'failed', error: err });
    }
  }
}
