import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createScheduleStore } from '../src/notetaker/schedule.js';
import { ingestCalendar, runTick, nextOccurrenceFromIcs, JOIN_LEAD_MS } from '../src/notetaker/intake.js';

const t = (iso) => Date.parse(iso);
const cal = (method, body) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nMETHOD:${method}\r\n${body}\r\nEND:VCALENDAR\r\n`;
const event = ({ uid = 'u1', organizer = 'bob@spotslocal.com', link = 'https://meet.google.com/abc-defg-hij', start = '20261006T150000Z', end = '20261006T153000Z', extra = '' } = {}) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nORGANIZER:mailto:${organizer}\r\nSUMMARY:Sync\r\n${link ? `LOCATION:${link}\r\n` : ''}${extra}END:VEVENT`;

const makeStore = () => createScheduleStore(new DatabaseSync(':memory:'));
const ALLOW = ['@spotslocal.com'];

test('ingestCalendar: an allowed Meet invite is scheduled and logged', () => {
  const store = makeStore();
  const lines = [];
  const out = ingestCalendar(cal('REQUEST', event()), { store, allowlist: ALLOW, nowMs: t('2026-10-04T00:00:00Z'), log: (m) => lines.push(m) });
  assert.deepEqual(out, ['added']);
  assert.equal(store.list()[0].state, 'scheduled');
  assert.match(lines[0], /^invite added: "Sync" \(meet\) by bob@spotslocal\.com at 2026-10-06T15:00:00\.000Z$/);
});

test('ingestCalendar: an organizer outside the allowlist is ignored, never stored (consent guard)', () => {
  const store = makeStore();
  const lines = [];
  const out = ingestCalendar(cal('REQUEST', event({ organizer: 'customer@gmail.com' })), {
    store, allowlist: ALLOW, nowMs: 0, log: (m) => lines.push(m),
  });
  assert.deepEqual(out, ['ignored']);
  assert.deepEqual(store.list(), []);
  assert.match(lines[0], /customer@gmail\.com.*not in NOTETAKER_ALLOWED_ORGANIZERS/);
});

test('ingestCalendar: a cancellation from a stranger cannot cancel an allowed meeting', () => {
  const store = makeStore();
  ingestCalendar(cal('REQUEST', event()), { store, allowlist: ALLOW, nowMs: 0, log: () => {} });
  ingestCalendar(cal('CANCEL', event({ organizer: 'x@gmail.com', extra: 'SEQUENCE:5\r\nSTATUS:CANCELLED\r\n' })), {
    store, allowlist: ALLOW, nowMs: 0, log: () => {},
  });
  assert.equal(store.list()[0].state, 'scheduled');
});

test('ingestCalendar: no Meet/Zoom link → skipped with a log line', () => {
  const store = makeStore();
  const lines = [];
  const out = ingestCalendar(cal('REQUEST', event({ link: null })), { store, allowlist: ALLOW, nowMs: 0, log: (m) => lines.push(m) });
  assert.deepEqual(out, ['no-link']);
  assert.deepEqual(store.list(), []);
  assert.match(lines[0], /no Google Meet or Zoom link/);
});

test('ingestCalendar: a cancellation of a known meeting cancels it', () => {
  const store = makeStore();
  ingestCalendar(cal('REQUEST', event()), { store, allowlist: ALLOW, nowMs: 0, log: () => {} });
  const out = ingestCalendar(cal('CANCEL', event({ extra: 'SEQUENCE:1\r\nSTATUS:CANCELLED\r\n' })), {
    store, allowlist: ALLOW, nowMs: 0, log: () => {},
  });
  assert.deepEqual(out, ['cancelled']);
  assert.equal(store.list()[0].state, 'cancelled');
});

test('ingestCalendar: unchanged re-reads are silent', () => {
  const store = makeStore();
  const lines = [];
  const opts = { store, allowlist: ALLOW, nowMs: 0, log: (m) => lines.push(m) };
  ingestCalendar(cal('REQUEST', event()), opts);
  ingestCalendar(cal('REQUEST', event()), opts);
  assert.equal(lines.length, 1);
});

test('runTick: dispatches a due meeting exactly once, marking it dispatched first', async () => {
  const store = makeStore();
  ingestCalendar(cal('REQUEST', event()), { store, allowlist: ALLOW, nowMs: 0, log: () => {} });
  const due = [];
  const onDue = (job) => {
    due.push([job.uid, store.list()[0].state]);
  };
  const nowMs = t('2026-10-06T15:00:00Z') - JOIN_LEAD_MS;
  await runTick({ store, nowMs, onDue, log: () => {} });
  await runTick({ store, nowMs: nowMs + 1000, onDue, log: () => {} });
  assert.deepEqual(due, [['u1', 'dispatched']]);
});

test('runTick: a throwing or rejecting onDue marks the meeting failed and never throws', async () => {
  for (const onDue of [() => { throw new Error('sync boom'); }, async () => { throw new Error('async boom'); }]) {
    const store = makeStore();
    ingestCalendar(cal('REQUEST', event()), { store, allowlist: ALLOW, nowMs: 0, log: () => {} });
    const lines = [];
    await runTick({ store, nowMs: t('2026-10-06T15:00:00Z'), onDue, log: (m) => lines.push(m) });
    assert.equal(store.list()[0].state, 'failed');
    assert.ok(lines.some((l) => /boom/.test(l)));
  }
});

test('runTick: rolls a finished weekly meeting to next week and logs it', async () => {
  const store = makeStore();
  ingestCalendar(cal('REQUEST', event({ extra: 'RRULE:FREQ=WEEKLY\r\n' })), { store, allowlist: ALLOW, nowMs: 0, log: () => {} });
  const lines = [];
  await runTick({ store, nowMs: t('2026-10-06T16:00:00Z'), onDue: () => {}, log: (m) => lines.push(m) });
  const [m] = store.list();
  assert.equal(m.state, 'scheduled');
  assert.equal(m.startsAtMs, t('2026-10-13T15:00:00Z'));
  assert.ok(lines.some((l) => /u1 → scheduled 2026-10-13T15:00:00\.000Z/.test(l)));
});

test('nextOccurrenceFromIcs: null for a cancelled or unparsable series', () => {
  assert.equal(nextOccurrenceFromIcs({ uid: 'u1', ics: 'junk' }, 0), null);
  const ics = cal('CANCEL', event({ extra: 'RRULE:FREQ=WEEKLY\r\nSTATUS:CANCELLED\r\n' }));
  assert.equal(nextOccurrenceFromIcs({ uid: 'u1', ics }, 0), null);
});
