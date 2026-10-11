import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

/**
 * On-device storage: finished 1-minute chunks wait in `<documents>/pending/`
 * until the server has them; settings (including the token) live in the
 * platform keychain/keystore via SecureStore. storage.web.js has the same
 * exports for the browser build.
 */

const SETTINGS_KEY = 'phone-recorder.settings';

export function pendingDir() {
  const dir = new Directory(Paths.document, 'pending');
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

/** Names of the chunk files waiting for upload. */
export function listPending() {
  return pendingDir()
    .list()
    .filter((entry) => entry instanceof File)
    .map((f) => f.name);
}

export function pendingFile(name) {
  return new File(pendingDir(), name);
}

/** PUT one pending chunk to `url`; `{ status, body }` of the server's answer. */
export async function putPending(name, url, headers) {
  const res = await pendingFile(name).upload(url, { httpMethod: 'PUT', headers });
  return { status: res.status, body: res.body };
}

export function deletePending(name) {
  pendingFile(name).delete();
}

/** Move a just-finished recording into the upload queue under its chunk name. */
export async function queueRecording(uri, name) {
  await new File(uri).move(pendingFile(name));
}

/**
 * @returns {Promise<{ serverUrl?: string, token?: string, deviceId?: string, windowMinutes?: number }>}
 */
export async function loadSettings() {
  const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveSettings(settings) {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}
