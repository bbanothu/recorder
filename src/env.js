import { join } from 'node:path';

import {
  AUTO_STOP_DEFAULT_MINUTES,
  AUTO_STOP_MIN_MINUTES,
  AUTO_STOP_MAX_MINUTES,
} from './auto-stop.js';

/**
 * @param {string | undefined} value
 * @param {boolean} [defaultValue=false]
 */
export function parseBool(value, defaultValue = false) {
  if (value == null || String(value).trim() === '') return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

/**
 * @param {string} value
 * @returns {string} validated ffmpeg-style bitrate (e.g. "24k", "32k")
 */
export function parseBitrate(value) {
  const v = String(value).trim().toLowerCase();
  if (!/^\d{1,4}k$/.test(v)) {
    throw new Error(`Invalid MASTER_BITRATE: ${value} (expected e.g. "24k")`);
  }
  return v;
}

const WHISPER_MODEL_RE = /^[A-Za-z0-9._/-]{1,120}$/;

/**
 * WHISPER_MODEL: a model name ("small") or HF repo id ("Systran/faster-whisper-small").
 * @param {string | undefined | null} value
 * @returns {string}
 */
export function parseWhisperModel(value) {
  const v = (value ?? 'small').trim();
  if (!WHISPER_MODEL_RE.test(v)) {
    throw new Error(`Invalid WHISPER_MODEL: ${value} (expected a model name or HF repo id, e.g. "small" or "Systran/faster-whisper-small")`);
  }
  return v;
}

/**
 * AUTO_STOP_MINUTES: whole minutes, AUTO_STOP_MIN_MINUTES..AUTO_STOP_MAX_MINUTES.
 * @param {string | undefined} value
 * @returns {number}
 */
export function parseAutoStopMinutes(value) {
  if (value == null || String(value).trim() === '') return AUTO_STOP_DEFAULT_MINUTES;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < AUTO_STOP_MIN_MINUTES || n > AUTO_STOP_MAX_MINUTES) {
    throw new Error(
      `Invalid AUTO_STOP_MINUTES: ${value} (expected integer ${AUTO_STOP_MIN_MINUTES}-${AUTO_STOP_MAX_MINUTES} minutes)`,
    );
  }
  return n;
}

/**
 * @returns {{
 *   DISCORD_BOT_TOKEN: string,
 *   MEETINGS_DIR: string,
 *   GUILD_IDS: string[],
 *   DB_PATH: string,
 *   TRANSCRIBE: boolean,
 *   WHISPER_MODEL: string,
 *   WHISPER_PYTHON: string | null,
 *   MASTER_BITRATE: string,
 *   AUTO_STOP_MINUTES: number,
 * }}
 */
export function loadEnv(env = process.env) {
  // v3.0.0 cutover: RECORDING_TYPE and TRANSCRIBE_MODE are gone from the env
  // surface. A value present in the environment (non-blank) is a hard startup
  // error naming the variable — no silent compatibility shim. A present-but-
  // blank value stays harmless (treated as unset). Checked BEFORE required-var
  // validation so the operator sees the actionable message first.
  if (env.RECORDING_TYPE != null && String(env.RECORDING_TYPE).trim() !== '') {
    throw new Error(
      'RECORDING_TYPE is no longer supported. Every session now records per-user tracks AND the master mix.',
    );
  }
  if (env.TRANSCRIBE_MODE != null && String(env.TRANSCRIBE_MODE).trim() !== '') {
    throw new Error(
      'TRANSCRIBE_MODE is no longer supported. Transcription is controlled by TRANSCRIBE (or /transcribe) and always uses the per-user tracks.',
    );
  }
  if (env.SINGLE_FILE != null && String(env.SINGLE_FILE).trim() !== '') {
    throw new Error('SINGLE_FILE is no longer supported. Every session records per-user tracks and the master mix.');
  }
  const required = ['DISCORD_BOT_TOKEN', 'MEETINGS_DIR', 'GUILD_IDS'];
  for (const name of required) {
    const value = env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
  const guildIds = env.GUILD_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (guildIds.length === 0) {
    throw new Error(
      'Missing required environment variable: GUILD_IDS (comma-separated guild snowflakes, e.g. "123,456")',
    );
  }
  // DB_PATH: pure path derivation, NO fs side effect here (loadEnv stays fs-
  // free so the suite never touches real paths). The actual parent-directory
  // mkdir happens in index.js at startup, wrapped in loud error handling.
  const dbPath = env.DB_PATH?.trim()
    ? env.DB_PATH.trim()
    : join(env.MEETINGS_DIR, 'recorder.db');
  return {
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    MEETINGS_DIR: env.MEETINGS_DIR,
    GUILD_IDS: guildIds,
    DB_PATH: dbPath,
    TRANSCRIBE: parseBool(env.TRANSCRIBE, true),
    WHISPER_MODEL: parseWhisperModel(env.WHISPER_MODEL),
    WHISPER_PYTHON: env.WHISPER_PYTHON?.trim() || null,
    MASTER_BITRATE: env.MASTER_BITRATE ? parseBitrate(env.MASTER_BITRATE) : '24k',
    AUTO_STOP_MINUTES: parseAutoStopMinutes(env.AUTO_STOP_MINUTES),
  };
}
