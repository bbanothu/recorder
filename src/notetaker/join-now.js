import 'dotenv/config';
import { logEvent } from '../log.js';
import { loadNotetakerEnv } from './env.js';
import { findJoinLink } from './invite.js';
import { createJoiner } from './joiner.js';

/**
 * Manual test: join a meeting link right now, without an invite.
 *   npm run notetaker:join -- https://meet.google.com/abc-defg-hij [minutes]
 * `minutes` (default 60) stands in for the invite's end time.
 */
const [link, minutesArg] = process.argv.slice(2);
const found = findJoinLink(link ?? '');
if (!found) {
  console.error('Usage: npm run notetaker:join -- <Google Meet link> [minutes]');
  process.exit(2);
}
const minutes = Number(minutesArg ?? 60);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error(`Invalid minutes: ${minutesArg}`);
  process.exit(2);
}

const env = loadNotetakerEnv();
const join = createJoiner(env);
const res = await join({
  uid: `manual-${Date.now()}`,
  platform: found.platform,
  joinUrl: found.url,
  summary: 'manual join',
  endsAtMs: Date.now() + minutes * 60_000,
});
logEvent(`manual join finished: ${res.outcome} (${res.reason})${res.mdPath ? ` → ${res.mdPath}` : ''}`);
process.exit(res.outcome === 'done' ? 0 : 1);
