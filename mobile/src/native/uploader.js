import { uploadOrder, parseChunkFileName, expiredChunkNames } from '../core/chunks.js';
// No extension, so Metro picks storage.web.js for the browser build.
import { deletePending, listPending, putPending } from './storage';

/**
 * Upload every pending chunk, oldest first. A chunk is deleted from the phone
 * only after the server answered 200/201 (it is idempotent, so a retry after a
 * lost response is safe). Stops at the first failure so order is kept.
 * @param {ReturnType<typeof import('../core/api.js').createApi>} api
 * @returns {Promise<number>} chunks uploaded
 */
export async function uploadPending(api) {
  let sent = 0;
  for (const name of uploadOrder(await listPending())) {
    const { startedAt, durationMs } = parseChunkFileName(name);
    const res = await putPending(name, api.chunkUrl(startedAt, durationMs), {
      ...api.authHeaders(),
      'content-type': 'audio/mp4',
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`upload failed (${res.status}): ${String(res.body).slice(0, 200)}`);
    }
    await deletePending(name);
    sent += 1;
  }
  return sent;
}

/** Delete pending chunks older than the window: an offline phone never grows past it. */
export async function sweepPending(windowMinutes, nowMs = Date.now()) {
  const expired = expiredChunkNames(await listPending(), nowMs, windowMinutes);
  for (const name of expired) await deletePending(name);
  return expired.length;
}
