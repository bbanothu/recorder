import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createScheduleStore } from '../src/notetaker/schedule.js';

const t = (iso) => Date.parse(iso);

function invite(over = {}) {
  return {
    uid: 'u1',
    sequence: 0,
    cancelled: false,
    organizer: 'bob@spotslocal.com',
    summary: 'Planning',
    platform: 'meet',
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    startsAtMs: t('2026-10-06T15:00:00Z'),
    endsAtMs: t('2026-10-06T15:30:00Z'),
    recurring: false,
    ics: 'BEGIN:VCALENDAR...',
    ...over,
  };
}

function makeStore(opts = {}) {
  return createScheduleStore(new DatabaseSync(':memory:'), {
    now: () => new Date('2026-10-04T12:00:00Z'),
    ...opts,
  });
}

test('applyInvite: a new invite is added as scheduled', () => {
  const s = makeStore();
  assert.equal(s.applyInvite(invite()), 'added');
  const [m] = s.list();
  assert.equal(m.uid, 'u1');
  assert.equal(m.state, 'scheduled');
  assert.equal(m.platform, 'meet');
  assert.equal(m.startsAtMs, t('2026-10-06T15:00:00Z'));
});

test('applyInvite: the same invite again is unchanged (both MIME parts of one mail)', () => {
  const s = makeStore();
  s.applyInvite(invite());
  assert.equal(s.applyInvite(invite()), 'unchanged');
  assert.equal(s.list().length, 1);
});

test('applyInvite: a higher SEQUENCE reschedules; a lower one is stale and ignored', () => {
  const s = makeStore();
  s.applyInvite(invite({ sequence: 2 }));
  assert.equal(s.applyInvite(invite({ sequence: 1, startsAtMs: 1, endsAtMs: 2 })), 'stale');
  assert.equal(
    s.applyInvite(invite({ sequence: 3, startsAtMs: t('2026-10-07T15:00:00Z'), endsAtMs: t('2026-10-07T16:00:00Z') })),
    'updated',
  );
  const [m] = s.list();
  assert.equal(m.sequence, 3);
  assert.equal(m.startsAtMs, t('2026-10-07T15:00:00Z'));
  assert.equal(m.state, 'scheduled');
});

test('applyInvite: a cancel at the same or higher SEQUENCE cancels; an older cancel is stale', () => {
  const s = makeStore();
  s.applyInvite(invite({ sequence: 1 }));
  assert.equal(s.applyInvite(invite({ sequence: 0, cancelled: true })), 'stale');
  assert.equal(s.applyInvite(invite({ sequence: 1, cancelled: true })), 'cancelled');
  assert.equal(s.list()[0].state, 'cancelled');
  // A cancel for an unknown meeting is recorded too, so a late-arriving
  // REQUEST at a lower sequence can never resurrect it.
  assert.equal(s.applyInvite(invite({ uid: 'u2', sequence: 4, cancelled: true })), 'cancelled');
  assert.equal(s.applyInvite(invite({ uid: 'u2', sequence: 3 })), 'stale');
});

test('dueJobs: scheduled jobs inside the lead window that have not ended', () => {
  const s = makeStore();
  s.applyInvite(invite({ uid: 'soon' }));
  s.applyInvite(invite({ uid: 'later', startsAtMs: t('2026-10-06T18:00:00Z'), endsAtMs: t('2026-10-06T19:00:00Z') }));
  const lead = 60_000;
  assert.deepEqual(s.dueJobs(t('2026-10-06T14:58:00Z'), lead).map((m) => m.uid), []);
  assert.deepEqual(s.dueJobs(t('2026-10-06T14:59:00Z'), lead).map((m) => m.uid), ['soon']);
  // Still due mid-meeting (late start / bot restart), never after the end.
  assert.deepEqual(s.dueJobs(t('2026-10-06T15:20:00Z'), lead).map((m) => m.uid), ['soon']);
  assert.deepEqual(s.dueJobs(t('2026-10-06T15:30:00Z'), lead).map((m) => m.uid), []);
});

test('dueJobs: only scheduled state is due', () => {
  const s = makeStore();
  s.applyInvite(invite());
  s.setState('u1', 'dispatched');
  assert.deepEqual(s.dueJobs(t('2026-10-06T15:00:00Z'), 60_000), []);
});

test('rollover: a past one-off scheduled meeting becomes missed; a dispatched one becomes done', () => {
  const s = makeStore();
  s.applyInvite(invite({ uid: 'a' }));
  s.applyInvite(invite({ uid: 'b' }));
  s.setState('b', 'dispatched');
  const changes = s.rollover(t('2026-10-06T16:00:00Z'), () => null);
  assert.deepEqual(changes.sort((x, y) => x.uid.localeCompare(y.uid)), [
    { uid: 'a', state: 'missed' },
    { uid: 'b', state: 'done' },
  ]);
});

test('rollover: an ended recurring meeting advances to its next occurrence and is scheduled again', () => {
  const s = makeStore();
  s.applyInvite(invite({ recurring: true }));
  s.setState('u1', 'dispatched');
  const next = { startsAtMs: t('2026-10-13T15:00:00Z'), endsAtMs: t('2026-10-13T15:30:00Z') };
  const seen = [];
  const changes = s.rollover(t('2026-10-06T16:00:00Z'), (row, nowMs) => {
    seen.push([row.uid, nowMs]);
    return next;
  });
  assert.deepEqual(seen, [['u1', t('2026-10-06T16:00:00Z')]]);
  assert.deepEqual(changes, [{ uid: 'u1', state: 'scheduled', startsAtMs: next.startsAtMs }]);
  const [m] = s.list();
  assert.equal(m.state, 'scheduled');
  assert.equal(m.startsAtMs, next.startsAtMs);
  assert.equal(m.endsAtMs, next.endsAtMs);
});

test('rollover: a recurring series with no further occurrence is done', () => {
  const s = makeStore();
  s.applyInvite(invite({ recurring: true }));
  assert.deepEqual(s.rollover(t('2026-10-06T16:00:00Z'), () => null), [{ uid: 'u1', state: 'done' }]);
});

test('rollover: cancelled and running meetings are left alone', () => {
  const s = makeStore();
  s.applyInvite(invite({ uid: 'c', cancelled: true }));
  s.applyInvite(invite({ uid: 'r' }));
  assert.deepEqual(s.rollover(t('2026-10-06T15:10:00Z'), () => null), []);
  assert.deepEqual(s.rollover(t('2026-10-06T16:00:00Z'), () => null), [{ uid: 'r', state: 'missed' }]);
  assert.equal(s.list().find((m) => m.uid === 'c').state, 'cancelled');
});

test('processed messages: remembered per key, independent of meetings', () => {
  const s = makeStore();
  assert.equal(s.isMessageProcessed('7:42'), false);
  s.markMessageProcessed('7:42');
  s.markMessageProcessed('7:42'); // idempotent
  assert.equal(s.isMessageProcessed('7:42'), true);
  assert.equal(s.isMessageProcessed('8:42'), false);
});

test('setState: rejects unknown states', () => {
  const s = makeStore();
  s.applyInvite(invite());
  assert.throws(() => s.setState('u1', 'bogus'), /Unknown meeting state/);
});

test('recoverInterrupted: a meeting left dispatched/recording by a dead process is rejoined if still running', () => {
  const s = makeStore();
  s.applyInvite(invite({ uid: 'live' }));
  s.applyInvite(invite({ uid: 'over', startsAtMs: t('2026-10-06T13:00:00Z'), endsAtMs: t('2026-10-06T14:00:00Z') }));
  s.applyInvite(invite({ uid: 'fine' }));
  s.setState('live', 'recording');
  s.setState('over', 'recording');
  const recovered = s.recoverInterrupted(t('2026-10-06T15:10:00Z'));
  assert.deepEqual(recovered, ['live']);
  const state = Object.fromEntries(s.list().map((m) => [m.uid, m.state]));
  assert.deepEqual(state, { over: 'done', live: 'scheduled', fine: 'scheduled' });
});
