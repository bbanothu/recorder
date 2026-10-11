import 'dotenv/config';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { logEvent } from '../log.js';
import { ensureNodeSqliteSupport } from '../wiring.js';
import { runTranscription, defaultPythonBin } from '../transcribe.js';
import { loadPhoneEnv } from './env.js';
import { createPhoneStore } from './store.js';
import { createPhoneService } from './service.js';
import { createPhoneHandler } from './http.js';
import { concatAudio } from './audio.js';

/**
 * Phone recorder server (spec .project/specs/phone-recorder.md): receives
 * 1-minute chunks from the app over Tailscale, transcribes them with the
 * Whisper sidecar, keeps clips, deletes everything else after the window.
 */

const MAINTENANCE_MS = 15_000;

const env = loadPhoneEnv();
ensureNodeSqliteSupport();
mkdirSync(dirname(env.PHONE_DB_PATH), { recursive: true });
const { DatabaseSync } = await import('node:sqlite');
const store = createPhoneStore(new DatabaseSync(env.PHONE_DB_PATH), {
  defaultWindowMinutes: env.PHONE_DEFAULT_WINDOW_MINUTES,
});

const service = createPhoneService({
  store,
  root: join(env.MEETINGS_DIR, 'phone'),
  transcribe: (opts) =>
    runTranscription({
      pythonBin: env.WHISPER_PYTHON || defaultPythonBin(),
      model: env.WHISPER_MODEL,
      cacheDir: process.env.HF_HOME || undefined,
      ...opts,
    }),
  concatAudio: (inputs, out) => concatAudio(inputs, out),
});
service.resume();

let maintaining = false;
async function maintain() {
  if (maintaining) return;
  maintaining = true;
  try {
    await service.finalizeClips();
    await service.sweep();
  } catch (err) {
    logEvent(`phone: maintenance failed (${err?.message ?? err})`);
  } finally {
    maintaining = false;
  }
}

const server = createServer(
  createPhoneHandler({ service, token: env.PHONE_TOKEN, maxBytes: env.PHONE_MAX_CHUNK_MB * 1024 * 1024, version: pkg.version }),
);
server.listen(env.PHONE_PORT, env.PHONE_BIND, () => {
  logEvent(`phone-server v${pkg.version} listening on http://${env.PHONE_BIND}:${env.PHONE_PORT} (default window ${env.PHONE_DEFAULT_WINDOW_MINUTES} min)`);
});
await maintain();
setInterval(maintain, MAINTENANCE_MS);
