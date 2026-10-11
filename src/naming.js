const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * @param {string} displayName
 * @param {string} [userId]
 * @param {boolean} [dedupe=false]
 */
export function sanitizeName(displayName, userId, dedupe = false) {
  let name = String(displayName ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/[._ -]{2,}/g, (m) => m[0])
    .replace(/^[._ -]+|[._ -]+$/g, '')
    .slice(0, 60);

  if (!name) name = 'unknown';

  if (RESERVED.has(name.toUpperCase())) {
    name = `_${name}`.slice(0, 60);
  }

  if (dedupe && userId) {
    const suffix = `-${String(userId).slice(-6)}`;
    name = `${name.slice(0, Math.max(0, 60 - suffix.length))}${suffix}`;
  }

  return name;
}
