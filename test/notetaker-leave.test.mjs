import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLeave,
  nextAloneSince,
  ALONE_LEAVE_MS,
  END_GRACE_MS,
  HARD_CAP_MS,
} from '../src/notetaker/leave.js';

const joinedAtMs = 1_000_000;
const endsAtMs = joinedAtMs + 60 * 60_000;
const base = { joinedAtMs, endsAtMs, inCall: true, aloneSinceMs: null };

test('evaluateLeave: stays while others are in the call before the end', () => {
  assert.deepEqual(evaluateLeave({ ...base, nowMs: joinedAtMs + 10 * 60_000 }), { leave: false, reason: '' });
});

test('evaluateLeave: leaves at once when the bot is no longer in the call', () => {
  const r = evaluateLeave({ ...base, inCall: false, nowMs: joinedAtMs + 1000 });
  assert.equal(r.leave, true);
  assert.match(r.reason, /no longer in the call/);
});

test('evaluateLeave: leaves after being the only participant for ALONE_LEAVE_MS', () => {
  const aloneSinceMs = joinedAtMs + 5 * 60_000;
  assert.equal(evaluateLeave({ ...base, aloneSinceMs, nowMs: aloneSinceMs + ALONE_LEAVE_MS - 1 }).leave, false);
  const r = evaluateLeave({ ...base, aloneSinceMs, nowMs: aloneSinceMs + ALONE_LEAVE_MS });
  assert.equal(r.leave, true);
  assert.match(r.reason, /only participant for 2 min/);
});

test('evaluateLeave: leaves END_GRACE_MS after the scheduled end', () => {
  assert.equal(evaluateLeave({ ...base, nowMs: endsAtMs + END_GRACE_MS - 1 }).leave, false);
  const r = evaluateLeave({ ...base, nowMs: endsAtMs + END_GRACE_MS });
  assert.equal(r.leave, true);
  assert.match(r.reason, /30 min past the scheduled end/);
});

test('evaluateLeave: the hard cap wins even with no scheduled end', () => {
  const r = evaluateLeave({ ...base, endsAtMs: null, nowMs: joinedAtMs + HARD_CAP_MS });
  assert.equal(r.leave, true);
  assert.match(r.reason, /4 h cap/);
  assert.equal(evaluateLeave({ ...base, endsAtMs: null, nowMs: joinedAtMs + HARD_CAP_MS - 1 }).leave, false);
});

test('nextAloneSince: starts, keeps and clears the alone clock; unknown count never counts as alone', () => {
  assert.equal(nextAloneSince(null, 1, 500), 500);
  assert.equal(nextAloneSince(500, 1, 900), 500);
  assert.equal(nextAloneSince(500, 3, 900), null);
  assert.equal(nextAloneSince(null, null, 900), null);
  assert.equal(nextAloneSince(500, null, 900), null);
});
