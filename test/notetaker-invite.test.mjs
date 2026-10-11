import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findJoinLink,
  parseInvites,
  organizerEmail,
  parseAllowlist,
  isOrganizerAllowed,
} from '../src/notetaker/invite.js';

const CHICAGO_TZ = `BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:STANDARD
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
BEGIN:DAYLIGHT
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
END:VTIMEZONE`;

const cal = (method, body) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nMETHOD:${method}\r\n${body}\r\nEND:VCALENDAR\r\n`;

const GOOGLE_MEET = cal('REQUEST', `${CHICAGO_TZ}
BEGIN:VEVENT
DTSTART;TZID=America/Chicago:20261006T100000
DTEND;TZID=America/Chicago:20261006T103000
DTSTAMP:20261004T120000Z
ORGANIZER;CN=Bob Owner:mailto:Bob@SpotsLocal.com
UID:abc123@google.com
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Planning
END:VEVENT`);

const ZOOM = cal('REQUEST', `BEGIN:VEVENT
DTSTART:20261007T170000Z
DTEND:20261007T180000Z
DTSTAMP:20261004T120000Z
ORGANIZER;CN=Ann:mailto:ann@spotslocal.com
UID:ZOOM8123456789
LOCATION:https://us06web.zoom.us/j/8123456789?pwd=AbC123.1
DESCRIPTION:Join Zoom Meeting\\nhttps://us06web.zoom.us/j/8123456789?pwd=AbC123.1\\n\\nMeeting ID: 812 3456 7890
SUMMARY:Customer call
END:VEVENT`);

const t = (iso) => Date.parse(iso);

test('findJoinLink: Google Meet code URL', () => {
  assert.deepEqual(findJoinLink('see https://meet.google.com/abc-defg-hij?authuser=0 now'), {
    platform: 'meet',
    url: 'https://meet.google.com/abc-defg-hij',
  });
});

test('findJoinLink: Zoom join URL keeps the passcode query, drops trailing punctuation', () => {
  assert.deepEqual(findJoinLink('Join: https://us06web.zoom.us/j/8123456789?pwd=AbC123.1).'), {
    platform: 'zoom',
    url: 'https://us06web.zoom.us/j/8123456789?pwd=AbC123.1',
  });
  assert.deepEqual(findJoinLink('https://zoom.us/j/81234567890'), {
    platform: 'zoom',
    url: 'https://zoom.us/j/81234567890',
  });
});

test('findJoinLink: unrelated text or lookalike hosts → null', () => {
  assert.equal(findJoinLink('call me at 555-1234'), null);
  assert.equal(findJoinLink('https://meet.google.com.evil.example/abc-defg-hij'), null);
  assert.equal(findJoinLink('https://notzoom.us/j/8123456789'), null);
  assert.equal(findJoinLink(undefined), null);
});

test('parseInvites: Google Meet invite → one scheduled meet occurrence in UTC', () => {
  const [inv] = parseInvites(GOOGLE_MEET, { nowMs: t('2026-10-04T12:00:00Z') });
  assert.equal(inv.uid, 'abc123@google.com');
  assert.equal(inv.sequence, 0);
  assert.equal(inv.cancelled, false);
  assert.equal(inv.organizer, 'bob@spotslocal.com');
  assert.equal(inv.summary, 'Planning');
  assert.equal(inv.platform, 'meet');
  assert.equal(inv.joinUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(inv.startsAtMs, t('2026-10-06T15:00:00Z'));
  assert.equal(inv.endsAtMs, t('2026-10-06T15:30:00Z'));
  assert.equal(inv.recurring, false);
});

test('parseInvites: Zoom invite → zoom platform from LOCATION', () => {
  const [inv] = parseInvites(ZOOM, { nowMs: t('2026-10-04T12:00:00Z') });
  assert.equal(inv.platform, 'zoom');
  assert.equal(inv.joinUrl, 'https://us06web.zoom.us/j/8123456789?pwd=AbC123.1');
  assert.equal(inv.organizer, 'ann@spotslocal.com');
  assert.equal(inv.sequence, 0);
});

test('parseInvites: an invite without a meeting link is returned with platform null', () => {
  const ics = cal('REQUEST', `BEGIN:VEVENT
DTSTART:20261007T170000Z
DTEND:20261007T180000Z
UID:lunch-1
ORGANIZER:mailto:ann@spotslocal.com
SUMMARY:Lunch
END:VEVENT`);
  const [inv] = parseInvites(ics, { nowMs: 0 });
  assert.equal(inv.platform, null);
  assert.equal(inv.joinUrl, null);
});

test('parseInvites: METHOD:CANCEL marks the event cancelled', () => {
  const ics = cal('CANCEL', `BEGIN:VEVENT
DTSTART:20261007T170000Z
DTEND:20261007T180000Z
UID:ZOOM8123456789
SEQUENCE:1
STATUS:CANCELLED
ORGANIZER:mailto:ann@spotslocal.com
END:VEVENT`);
  const [inv] = parseInvites(ics, { nowMs: 0 });
  assert.equal(inv.cancelled, true);
  assert.equal(inv.sequence, 1);
});

test('parseInvites: weekly series → the next occurrence still running or upcoming, skipping EXDATE', () => {
  const ics = cal('REQUEST', `${CHICAGO_TZ}
BEGIN:VEVENT
DTSTART;TZID=America/Chicago:20261006T100000
DTEND;TZID=America/Chicago:20261006T103000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=America/Chicago:20261013T100000
UID:weekly@google.com
ORGANIZER:mailto:bob@spotslocal.com
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
END:VEVENT`);
  // Before the first one: the first one.
  let [inv] = parseInvites(ics, { nowMs: t('2026-10-01T00:00:00Z') });
  assert.equal(inv.recurring, true);
  assert.equal(inv.startsAtMs, t('2026-10-06T15:00:00Z'));
  // Mid-meeting: the running one, not the next.
  [inv] = parseInvites(ics, { nowMs: t('2026-10-06T15:10:00Z') });
  assert.equal(inv.startsAtMs, t('2026-10-06T15:00:00Z'));
  // After it ended: 10-13 is excluded, so 10-20.
  [inv] = parseInvites(ics, { nowMs: t('2026-10-06T16:00:00Z') });
  assert.equal(inv.startsAtMs, t('2026-10-20T15:00:00Z'));
  assert.equal(inv.endsAtMs, t('2026-10-20T15:30:00Z'));
});

test('parseInvites: a finished series has no occurrence (startsAtMs null)', () => {
  const ics = cal('REQUEST', `BEGIN:VEVENT
DTSTART:20261006T150000Z
DTEND:20261006T153000Z
RRULE:FREQ=DAILY;COUNT=2
UID:short@x
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
END:VEVENT`);
  const [inv] = parseInvites(ics, { nowMs: t('2026-10-09T00:00:00Z') });
  assert.equal(inv.startsAtMs, null);
});

test('parseInvites: garbage input → empty list, never a throw', () => {
  assert.deepEqual(parseInvites('not a calendar', { nowMs: 0 }), []);
  assert.deepEqual(parseInvites('', { nowMs: 0 }), []);
});

test('organizerEmail: object or string, mailto stripped, lowercased', () => {
  assert.equal(organizerEmail({ params: { CN: 'X' }, val: 'mailto:Bob@SpotsLocal.com' }), 'bob@spotslocal.com');
  assert.equal(organizerEmail('MAILTO:a@b.co'), 'a@b.co');
  assert.equal(organizerEmail(undefined), null);
});

test('allowlist: exact emails and @domain entries, case-insensitive', () => {
  const list = parseAllowlist(' @SpotsLocal.com , boss@gmail.com ');
  assert.deepEqual(list, ['@spotslocal.com', 'boss@gmail.com']);
  assert.equal(isOrganizerAllowed('bob@spotslocal.com', list), true);
  assert.equal(isOrganizerAllowed('Boss@Gmail.com', list), true);
  assert.equal(isOrganizerAllowed('other@gmail.com', list), false);
  // A suffix match on the domain is NOT a match.
  assert.equal(isOrganizerAllowed('x@evilspotslocal.com', list), false);
  assert.equal(isOrganizerAllowed('x@sub.spotslocal.com', list), false);
  assert.equal(isOrganizerAllowed(null, list), false);
});

test('parseAllowlist: rejects malformed entries loudly', () => {
  assert.throws(() => parseAllowlist('not-an-email'), /NOTETAKER_ALLOWED_ORGANIZERS/);
  assert.throws(() => parseAllowlist(' , '), /NOTETAKER_ALLOWED_ORGANIZERS/);
});
