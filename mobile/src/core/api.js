/**
 * Client for the phone server (src/phone/http.js). `fetch` is injected so the
 * logic is testable; chunk uploads go through expo-file-system (see
 * src/native/uploader.js) and only borrow `chunkUrl` / `authHeaders` from here.
 * @param {{ serverUrl: string, token: string, deviceId: string, fetch?: typeof fetch }} o
 */
export function createApi({ serverUrl, token, deviceId, fetch: fetchFn = globalThis.fetch }) {
  const base = `${serverUrl}/v1/devices/${encodeURIComponent(deviceId)}`;
  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  async function call(url, method = 'GET', body) {
    const headers = { ...authHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const res = await fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status}: ${data.error ?? 'request failed'}`);
    return data;
  }

  return {
    authHeaders,
    chunkUrl: (startedAt, durationMs) => `${base}/chunks/${startedAt}?durationMs=${durationMs}`,
    health: () => call(`${serverUrl}/v1/health`),
    setWindow: (windowMinutes) => call(base, 'PUT', { windowMinutes }),
    createClip: ({ fromMs, toMs }) => call(`${base}/clips`, 'POST', { fromMs, toMs }),
    listClips: () => call(`${base}/clips`),
    getClip: (id) => call(`${base}/clips/${id}`),
    deleteClip: (id) => call(`${base}/clips/${id}`, 'DELETE'),
    deleteAllClips: () => call(`${base}/clips`, 'DELETE'),
    translateClip: (id) => call(`${base}/clips/${id}/translate`, 'POST'),
    redoClip: (id) => call(`${base}/clips/${id}/redo`, 'POST'),
    updateClipMarkdown: (id, markdown) => call(`${base}/clips/${id}/transcript`, 'PUT', { markdown }),
    deleteClipAudio: (id) => call(`${base}/clips/${id}/audio`, 'DELETE'),
    deleteClipText: (id) => call(`${base}/clips/${id}/transcript`, 'DELETE'),
  };
}
