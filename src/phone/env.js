import { join } from 'node:path';
import { isIP } from 'node:net';
import { parseWhisperModel } from '../env.js';

function intInRange(name, value, min, max, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: ${value} (expected integer ${min}-${max})`);
  }
  return n;
}

/**
 * Phone server environment (spec .project/specs/phone-recorder.md), validated
 * at load. Shares `.env`, MEETINGS_DIR and the Whisper settings with the bot.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadPhoneEnv(env = process.env) {
  for (const name of ['MEETINGS_DIR', 'PHONE_TOKEN']) {
    if (!env[name] || !String(env[name]).trim()) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
  const token = env.PHONE_TOKEN.trim();
  if (token.length < 24) throw new Error('Invalid PHONE_TOKEN: use at least 24 random characters (e.g. `openssl rand -hex 24`)');

  // Loopback by default: binding to the tailnet address is an explicit choice.
  const bind = env.PHONE_BIND?.trim() || '127.0.0.1';
  if (!isIP(bind)) throw new Error(`Invalid PHONE_BIND: ${bind} (expected an IP address, e.g. your Tailscale 100.x address)`);

  return {
    MEETINGS_DIR: env.MEETINGS_DIR,
    PHONE_TOKEN: token,
    PHONE_BIND: bind,
    PHONE_PORT: intInRange('PHONE_PORT', env.PHONE_PORT, 1, 65535, 8787),
    PHONE_DB_PATH: env.PHONE_DB_PATH?.trim() || join(env.MEETINGS_DIR, 'phone.db'),
    PHONE_DEFAULT_WINDOW_MINUTES: intInRange('PHONE_DEFAULT_WINDOW_MINUTES', env.PHONE_DEFAULT_WINDOW_MINUTES, 1, 1440, 60),
    PHONE_MAX_CHUNK_MB: intInRange('PHONE_MAX_CHUNK_MB', env.PHONE_MAX_CHUNK_MB, 1, 500, 50),
    WHISPER_MODEL: parseWhisperModel(env.WHISPER_MODEL),
    WHISPER_PYTHON: env.WHISPER_PYTHON?.trim() || null,
  };
}
