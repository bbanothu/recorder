import { join } from 'node:path';
import { parseAllowlist } from './invite.js';
import { parseBool, parseWhisperModel } from '../env.js';

const EMAIL_RE = /^[^\s@,]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// Reaches spawn() as the browser binary: an absolute path, no shell specials.
const PATH_RE = /^\/[A-Za-z0-9._/ -]+$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// Shown to every meeting participant: printable, no control characters.
const BOT_NAME_RE = /^[\p{L}\p{N} ._'()-]{1,64}$/u;

function intInRange(name, value, min, max, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: ${value} (expected integer ${min}-${max})`);
  }
  return n;
}

/**
 * Notetaker environment (spec "Environment"), validated at load. Independent
 * of the Discord bot's variables: the two processes share `.env` and
 * MEETINGS_DIR only.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadNotetakerEnv(env = process.env) {
  for (const name of ['MEETINGS_DIR', 'NOTETAKER_EMAIL', 'NOTETAKER_APP_PASSWORD', 'NOTETAKER_ALLOWED_ORGANIZERS']) {
    if (!env[name] || !String(env[name]).trim()) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
  const email = env.NOTETAKER_EMAIL.trim();
  if (!EMAIL_RE.test(email)) throw new Error(`Invalid NOTETAKER_EMAIL: ${email}`);

  const botName = env.NOTETAKER_BOT_NAME?.trim() || 'SpotsLocal Recorder';
  if (!BOT_NAME_RE.test(botName)) {
    throw new Error(`Invalid NOTETAKER_BOT_NAME: ${botName} (1-64 letters, digits, spaces, . _ ' ( ) -)`);
  }
  const host = env.NOTETAKER_IMAP_HOST?.trim() || 'imap.zoho.com';
  if (!HOST_RE.test(host)) throw new Error(`Invalid NOTETAKER_IMAP_HOST: ${host}`);

  const chromePath = env.NOTETAKER_CHROME_PATH?.trim() || null;
  if (chromePath && !PATH_RE.test(chromePath)) {
    throw new Error(`Invalid NOTETAKER_CHROME_PATH: ${chromePath} (expected an absolute path to a Chrome/Chromium binary)`);
  }

  return {
    MEETINGS_DIR: env.MEETINGS_DIR,
    NOTETAKER_EMAIL: email,
    NOTETAKER_APP_PASSWORD: env.NOTETAKER_APP_PASSWORD,
    NOTETAKER_ALLOWED_ORGANIZERS: parseAllowlist(env.NOTETAKER_ALLOWED_ORGANIZERS),
    NOTETAKER_BOT_NAME: botName,
    NOTETAKER_IMAP_HOST: host,
    NOTETAKER_IMAP_PORT: intInRange('NOTETAKER_IMAP_PORT', env.NOTETAKER_IMAP_PORT, 1, 65535, 993),
    NOTETAKER_DB_PATH: env.NOTETAKER_DB_PATH?.trim() || join(env.MEETINGS_DIR, 'notetaker.db'),
    NOTETAKER_POLL_SECONDS: intInRange('NOTETAKER_POLL_SECONDS', env.NOTETAKER_POLL_SECONDS, 15, 3600, 60),
    NOTETAKER_LOOKBACK_DAYS: intInRange('NOTETAKER_LOOKBACK_DAYS', env.NOTETAKER_LOOKBACK_DAYS, 1, 90, 14),
    NOTETAKER_ADMIT_TIMEOUT_MIN: intInRange('NOTETAKER_ADMIT_TIMEOUT_MIN', env.NOTETAKER_ADMIT_TIMEOUT_MIN, 1, 60, 10),
    NOTETAKER_BROWSER_PROFILE: env.NOTETAKER_BROWSER_PROFILE?.trim() || join(env.MEETINGS_DIR, 'notetaker-browser'),
    NOTETAKER_CHROME_PATH: chromePath,
    NOTETAKER_HEADLESS: parseBool(env.NOTETAKER_HEADLESS, false),
    WHISPER_MODEL: parseWhisperModel(env.WHISPER_MODEL),
    WHISPER_PYTHON: env.WHISPER_PYTHON?.trim() || null,
  };
}
