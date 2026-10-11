import { logEvent } from '../log.js';
import { parseInvites, isOrganizerAllowed } from './invite.js';

/** Hand a meeting to the joiner this long before its start time. */
export const JOIN_LEAD_MS = 60_000;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Fold one iCalendar body into the schedule. The consent guard (spec D3) runs
 * first: an organizer outside the allowlist can neither schedule nor cancel.
 * @param {string} icsText
 * @param {{
 *   store: ReturnType<typeof import('./schedule.js').createScheduleStore>,
 *   allowlist: string[],
 *   nowMs: number,
 *   log?: (message: string) => void,
 * }} deps
 * @returns {string[]} one outcome per VEVENT
 */
export function ingestCalendar(icsText, { store, allowlist, nowMs, log = logEvent }) {
  const outcomes = [];
  for (const inv of parseInvites(icsText, { nowMs })) {
    const what = `"${inv.summary || '(no title)'}"`;
    if (!isOrganizerAllowed(inv.organizer, allowlist)) {
      log(`invite ${what} ignored: organizer ${inv.organizer ?? '(none)'} is not in NOTETAKER_ALLOWED_ORGANIZERS`);
      outcomes.push('ignored');
      continue;
    }
    if (!inv.cancelled && !inv.platform) {
      log(`invite ${what} skipped: no Google Meet or Zoom link found`);
      outcomes.push('no-link');
      continue;
    }
    if (!inv.cancelled && inv.startsAtMs == null) {
      log(`invite ${what} skipped: the series has no upcoming occurrence`);
      outcomes.push('ended');
      continue;
    }
    const action = store.applyInvite(inv);
    if (action !== 'unchanged') {
      log(
        action === 'cancelled' || action === 'stale'
          ? `invite ${action}: ${what} (${inv.uid})`
          : `invite ${action}: ${what} (${inv.platform}) by ${inv.organizer} at ${iso(inv.startsAtMs)}`,
      );
    }
    outcomes.push(action);
  }
  return outcomes;
}

/**
 * Rollover callback for the store: re-parse the stored invite and return the
 * occurrence running or next at `nowMs`.
 * @param {{ uid: string, ics: string | null }} meeting
 * @param {number} nowMs
 */
export function nextOccurrenceFromIcs(meeting, nowMs) {
  const inv = parseInvites(meeting.ics ?? '', { nowMs }).find(
    (i) => i.uid === meeting.uid && !i.cancelled,
  );
  return inv && inv.startsAtMs != null ? { startsAtMs: inv.startsAtMs, endsAtMs: inv.endsAtMs } : null;
}

/**
 * One scheduler tick: settle ended meetings, then dispatch due ones. A meeting
 * is marked `dispatched` BEFORE `onDue` runs so an overlapping tick can never
 * join it twice; a throw or rejection from `onDue` marks it `failed`. Never
 * throws.
 * @param {{
 *   store: ReturnType<typeof import('./schedule.js').createScheduleStore>,
 *   nowMs: number,
 *   leadMs?: number,
 *   onDue: (meeting: object) => unknown,
 *   log?: (message: string) => void,
 * }} deps
 */
export async function runTick({ store, nowMs, leadMs = JOIN_LEAD_MS, onDue, log = logEvent }) {
  try {
    for (const c of store.rollover(nowMs, nextOccurrenceFromIcs)) {
      log(`meeting ${c.uid} → ${c.state}${c.startsAtMs != null ? ` ${iso(c.startsAtMs)}` : ''}`);
    }
  } catch (err) {
    log(`schedule rollover failed (${err?.message ?? err})`);
  }
  let due = [];
  try {
    due = store.dueJobs(nowMs, leadMs);
  } catch (err) {
    log(`schedule read failed (${err?.message ?? err})`);
  }
  for (const job of due) {
    try {
      store.setState(job.uid, 'dispatched');
      await onDue(job);
    } catch (err) {
      log(`meeting ${job.uid} could not be dispatched (${err?.message ?? err})`);
      try {
        store.setState(job.uid, 'failed');
      } catch {
        /* already logged; the next tick retries nothing for this meeting */
      }
    }
  }
}
