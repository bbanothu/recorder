import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ImapFlow } from 'imapflow';
import pkg from '../../package.json' with { type: 'json' };
import { logEvent } from '../log.js';
import { ensureNodeSqliteSupport } from '../wiring.js';
import { loadNotetakerEnv } from './env.js';
import { createScheduleStore } from './schedule.js';
import { pollMailbox, describeImapError } from './mailbox.js';
import { ingestCalendar, runTick } from './intake.js';
import { createJoiner } from './joiner.js';

/**
 * Invite notetaker (spec .project/specs/notetaker-invite-bot.md): IMAP intake
 * + schedule (phase 2) and the Google Meet joiner (phase 3). Separate process
 * from the Discord bot: a browser crash must never cost a Discord recording.
 */

const SCHEDULER_TICK_MS = 15_000;

const env = loadNotetakerEnv();
ensureNodeSqliteSupport();
mkdirSync(dirname(env.NOTETAKER_DB_PATH), { recursive: true });

const { DatabaseSync } = await import('node:sqlite');
const store = createScheduleStore(new DatabaseSync(env.NOTETAKER_DB_PATH));

const createClient = () =>
  new ImapFlow({
    host: env.NOTETAKER_IMAP_HOST,
    port: env.NOTETAKER_IMAP_PORT,
    secure: true,
    auth: { user: env.NOTETAKER_EMAIL, pass: env.NOTETAKER_APP_PASSWORD },
    logger: false,
  });

const joinMeeting = createJoiner(env);
const setState = (uid, state) => {
  try {
    store.setState(uid, state);
  } catch (err) {
    logEvent(`meeting ${uid}: could not record state ${state} (${err?.message ?? err})`);
  }
};

// One meeting at a time (spec Risks: ~1-1.5 GB RAM per browser). The session
// runs detached: the scheduler tick must keep settling and polling meanwhile.
let active = null;
const onDue = (m) => {
  const what = `"${m.summary || '(no title)'}"`;
  if (active) {
    logEvent(`meeting ${what} refused: already in meeting ${active}`);
    setState(m.uid, 'failed');
    return;
  }
  active = what;
  joinMeeting(m, { onRecording: () => setState(m.uid, 'recording') })
    .then((res) => setState(m.uid, res.outcome === 'done' ? 'done' : 'failed'))
    .catch((err) => {
      logEvent(`meeting ${what} crashed (${err?.message ?? err})`);
      setState(m.uid, 'failed');
    })
    .finally(() => {
      active = null;
    });
};

let polling = false;
async function poll() {
  if (polling) return; // a slow IMAP server must never stack polls
  polling = true;
  try {
    const nowMs = Date.now();
    const res = await pollMailbox({
      createClient,
      store,
      sinceMs: nowMs - env.NOTETAKER_LOOKBACK_DAYS * 86_400_000,
      onCalendar: (text) => {
        ingestCalendar(text, { store, allowlist: env.NOTETAKER_ALLOWED_ORGANIZERS, nowMs: Date.now() });
      },
    });
    if (res.fresh) logEvent(`mailbox: ${res.fresh} new message(s), ${res.calendars} calendar part(s)`);
  } catch (err) {
    logEvent(`mailbox poll failed (${describeImapError(err)}); check NOTETAKER_EMAIL / NOTETAKER_APP_PASSWORD and that IMAP is enabled in Zoho`);
  } finally {
    polling = false;
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await runTick({ store, nowMs: Date.now(), onDue });
  } finally {
    ticking = false;
  }
}

logEvent(
  `notetaker v${pkg.version} watching ${env.NOTETAKER_EMAIL} (${env.NOTETAKER_IMAP_HOST}) every ${env.NOTETAKER_POLL_SECONDS}s; ` +
    `organizers allowed: ${env.NOTETAKER_ALLOWED_ORGANIZERS.join(', ')}`,
);
for (const uid of store.recoverInterrupted(Date.now())) {
  logEvent(`meeting ${uid} was interrupted by a restart; rejoining`);
}
const upcoming = store.list().filter((m) => m.state === 'scheduled');
logEvent(`schedule: ${upcoming.length} upcoming meeting(s) in ${env.NOTETAKER_DB_PATH}`);

await poll();
await tick();
setInterval(poll, env.NOTETAKER_POLL_SECONDS * 1000);
setInterval(tick, SCHEDULER_TICK_MS);
