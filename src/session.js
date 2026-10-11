import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeName } from './naming.js';

/**
 * @param {string} meetingsRoot
 * @param {Date} startedAt
 * @param {string} guildId Discord guild snowflake (17-20 digits)
 */
export function sessionDir(meetingsRoot, startedAt, guildId) {
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new Error(`Invalid guild id for the session directory: ${guildId}`);
  }
  const y = startedAt.getUTCFullYear();
  const mo = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startedAt.getUTCDate()).padStart(2, '0');
  const h = String(startedAt.getUTCHours()).padStart(2, '0');
  const mi = String(startedAt.getUTCMinutes()).padStart(2, '0');
  const s = String(startedAt.getUTCSeconds()).padStart(2, '0');
  const dir = join(
    meetingsRoot,
    'discord-meetings',
    guildId,
    `meeting-${y}-${mo}-${d}-${h}-${mi}-${s}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compact UTC stamp for filenames: YYYYMMDD-HHMMSS-mmm
 * @param {Date} [at]
 */
export function fileTimestamp(at = new Date()) {
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  const h = String(at.getUTCHours()).padStart(2, '0');
  const mi = String(at.getUTCMinutes()).padStart(2, '0');
  const s = String(at.getUTCSeconds()).padStart(2, '0');
  const ms = String(at.getUTCMilliseconds()).padStart(3, '0');
  return `${y}${mo}${d}-${h}${mi}${s}-${ms}`;
}

/**
 * Per-segment path: `<sanitizedDisplayName>-<timestamp>.ogg` (always unique).
 * @param {string} dir
 * @param {string} displayName
 * @param {string} [userId]
 * @param {Date} [at]
 */
export function sessionUserFile(dir, displayName, userId, at = new Date()) {
  const name = sanitizeName(displayName, userId, false);
  return join(dir, `${name}-${fileTimestamp(at)}.ogg`);
}

/**
 * Mixed master path: `master-<timestamp>.ogg`
 * @param {string} dir
 * @param {Date} [at]
 */
export function sessionMasterFile(dir, at = new Date()) {
  return join(dir, `master-${fileTimestamp(at)}.ogg`);
}

/**
 * Session timeline path: `timeline-<timestamp>.jsonl`. Pass the recorder's
 * single session-zero read (`startedAtMs`) so it sits beside `master-<stamp>.ogg`
 * for the same instant; never derive it from a second clock read.
 * @param {string} dir
 * @param {Date} [at]
 */
export function sessionTimelineFile(dir, at = new Date()) {
  return join(dir, `timeline-${fileTimestamp(at)}.jsonl`);
}
