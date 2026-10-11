/**
 * Browser build of storage.js (same exports). There is no file system or
 * keychain on the web: pending chunks are Blobs in IndexedDB, so a reload
 * does not lose them, and settings live in localStorage.
 */

const SETTINGS_KEY = 'phone-recorder.settings';
const DB_NAME = 'phone-recorder';
const STORE = 'pending';

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Names of the chunks waiting for upload. */
export async function listPending() {
  return (await tx('readonly', (s) => s.getAllKeys())).map(String);
}

/** Store a just-finished recording (a `blob:` URL from expo-audio) under its chunk name. */
export async function queueRecording(uri, name) {
  const blob = await (await fetch(uri)).blob();
  URL.revokeObjectURL(uri);
  await tx('readwrite', (s) => s.put(blob, name));
}

/** PUT one pending chunk to `url`; `{ status, body }` of the server's answer. */
export async function putPending(name, url, headers) {
  const blob = await tx('readonly', (s) => s.get(name));
  if (!blob) return { status: 404, body: 'chunk missing from browser storage' };
  const res = await fetch(url, { method: 'PUT', headers, body: blob });
  return { status: res.status, body: await res.text() };
}

export async function deletePending(name) {
  await tx('readwrite', (s) => s.delete(name));
}

/**
 * @returns {Promise<{ serverUrl?: string, token?: string, deviceId?: string, windowMinutes?: number }>}
 */
export async function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
