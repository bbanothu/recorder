import ical from 'node-ical';

/**
 * Pure invite parsing for the notetaker: iCalendar text in, plain invite
 * records out. No I/O, no clock reads (`nowMs` is passed in).
 */

const MEET_RE = /https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![\w.-])/i;
// Host is zoom.us or any subdomain of it; the passcode query is kept.
const ZOOM_RE = /https:\/\/((?:[a-z0-9-]+\.)*zoom\.us)\/j\/(\d{9,11})(\?[^\s"'<>()\\]*)?/i;

/** Default meeting length when an event carries no DTEND/DURATION. */
const DEFAULT_DURATION_MS = 60 * 60_000;
/** Upper bound on occurrences skipped (EXDATE) while looking for the next one. */
const MAX_OCCURRENCE_SCAN = 1000;

/**
 * First Google Meet or Zoom join link in free text.
 * @param {unknown} text
 * @returns {{ platform: 'meet' | 'zoom', url: string } | null}
 */
export function findJoinLink(text) {
  if (typeof text !== 'string' || !text) return null;
  const meet = MEET_RE.exec(text);
  if (meet) return { platform: 'meet', url: `https://meet.google.com/${meet[1].toLowerCase()}` };
  const zoom = ZOOM_RE.exec(text);
  if (zoom) {
    // Trailing sentence punctuation is never part of a passcode.
    const query = (zoom[3] ?? '').replace(/[.,;:!?]+$/, '');
    return { platform: 'zoom', url: `https://${zoom[1].toLowerCase()}/j/${zoom[2]}${query}` };
  }
  return null;
}

/**
 * @param {unknown} organizer node-ical ORGANIZER value (`{ val, params }` or a string)
 * @returns {string | null} bare lowercase email
 */
export function organizerEmail(organizer) {
  const raw = typeof organizer === 'string' ? organizer : organizer?.val;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().replace(/^mailto:/i, '').toLowerCase();
}

const EMAIL_RE = /^[^\s@,]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * NOTETAKER_ALLOWED_ORGANIZERS: comma-separated emails and/or `@domain` entries.
 * @param {string | undefined} value
 * @returns {string[]} lowercase entries
 */
export function parseAllowlist(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) {
    throw new Error(
      'NOTETAKER_ALLOWED_ORGANIZERS is empty (expected comma-separated emails or @domain entries, e.g. "@spotslocal.com")',
    );
  }
  for (const e of entries) {
    if (!EMAIL_RE.test(e) && !DOMAIN_RE.test(e)) {
      throw new Error(`Invalid NOTETAKER_ALLOWED_ORGANIZERS entry: ${e} (expected an email or @domain)`);
    }
  }
  return entries;
}

/**
 * Consent guard (spec D3): an exact email, or an exact `@domain` (no suffix or
 * subdomain match).
 * @param {string | null} email
 * @param {string[]} allowlist parsed entries
 */
export function isOrganizerAllowed(email, allowlist) {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  const e = email.toLowerCase();
  const domain = e.slice(e.lastIndexOf('@'));
  return allowlist.some((entry) => (entry.startsWith('@') ? entry === domain : entry === e));
}

function isExcluded(ev, occ) {
  if (!ev.exdate) return false;
  const ms = occ.getTime();
  return Object.values(ev.exdate).some((d) => d instanceof Date && d.getTime() === ms);
}

/**
 * The occurrence still running or next to start at `nowMs` (end > nowMs).
 * A one-off event returns its own times even when past (the store decides
 * what a past event means).
 */
function occurrenceFor(ev, nowMs) {
  const startMs = ev.start instanceof Date ? ev.start.getTime() : NaN;
  if (!Number.isFinite(startMs)) return { startsAtMs: null, endsAtMs: null };
  const endMs = ev.end instanceof Date ? ev.end.getTime() : NaN;
  const durationMs = Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : DEFAULT_DURATION_MS;
  if (!ev.rrule) return { startsAtMs: startMs, endsAtMs: startMs + durationMs };

  let cursor = new Date(nowMs - durationMs);
  for (let i = 0; i < MAX_OCCURRENCE_SCAN; i++) {
    const occ = ev.rrule.after(cursor, false);
    if (!occ) break;
    if (!isExcluded(ev, occ)) {
      return { startsAtMs: occ.getTime(), endsAtMs: occ.getTime() + durationMs };
    }
    cursor = occ;
  }
  return { startsAtMs: null, endsAtMs: null };
}

/**
 * Every VEVENT in an iCalendar body as a plain invite record. Never throws:
 * unparsable input is an empty list.
 * @param {string} icsText
 * @param {{ nowMs: number }} opts
 * @returns {Array<{
 *   uid: string, sequence: number, cancelled: boolean, organizer: string | null,
 *   summary: string | null, platform: 'meet' | 'zoom' | null, joinUrl: string | null,
 *   startsAtMs: number | null, endsAtMs: number | null, recurring: boolean, ics: string,
 * }>}
 */
export function parseInvites(icsText, { nowMs }) {
  if (typeof icsText !== 'string' || !icsText.trim()) return [];
  let data;
  try {
    data = ical.sync.parseICS(icsText);
  } catch {
    return [];
  }
  const out = [];
  for (const ev of Object.values(data ?? {})) {
    if (ev?.type !== 'VEVENT' || typeof ev.uid !== 'string') continue;
    const link =
      findJoinLink(ev['GOOGLE-CONFERENCE']) ??
      findJoinLink(typeof ev.url === 'string' ? ev.url : ev.url?.val) ??
      findJoinLink(ev.location) ??
      findJoinLink(ev.description);
    const method = String(ev.method ?? '').toUpperCase();
    const status = String(ev.status ?? '').toUpperCase();
    const seq = Number(ev.sequence);
    out.push({
      uid: ev.uid,
      sequence: Number.isInteger(seq) && seq >= 0 ? seq : 0,
      cancelled: method === 'CANCEL' || status === 'CANCELLED',
      organizer: organizerEmail(ev.organizer),
      summary: typeof ev.summary === 'string' ? ev.summary : (ev.summary?.val ?? null),
      platform: link?.platform ?? null,
      joinUrl: link?.url ?? null,
      ...occurrenceFor(ev, nowMs),
      recurring: Boolean(ev.rrule),
      ics: icsText,
    });
  }
  return out;
}
