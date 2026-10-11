const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate what the user typed on the Settings screen.
 * @param {{ serverUrl?: string, token?: string, deviceId?: string }} input
 * @returns {{ ok: true, settings: { serverUrl: string, token: string, deviceId: string } } | { ok: false, errors: string[] }}
 */
export function normalizeSettings(input) {
  const serverUrl = String(input.serverUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(input.token ?? '').trim();
  const deviceId = String(input.deviceId ?? '').trim();
  const errors = [];
  if (!/^https?:\/\/[^\s/]+/.test(serverUrl)) errors.push('Server URL must start with http:// or https://');
  if (!token) errors.push('Token is required');
  // The server uses it as a directory name; same rule as src/phone/service.js.
  if (!DEVICE_ID_RE.test(deviceId)) errors.push('Device id: 1-64 of A-Z a-z 0-9 _ -');
  return errors.length ? { ok: false, errors } : { ok: true, settings: { serverUrl, token, deviceId } };
}

/** A fresh device id: `phone-` + 8 hex characters. */
export function newDeviceId(random = Math.random) {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += Math.floor(random() * 16).toString(16);
  return `phone-${hex}`;
}
