import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTimeline, rejoinNotes } from '../src/timeline-read.js';

const L = (o) => JSON.stringify(o);
const T0 = 1_000_000;

const fixture = [
  L({ v: 1, type: 'session', t0: T0, guildId: 'g', botUserId: 'b', dir: 'd', version: '3.0.2' }),
  L({ v: 1, type: 'track', userId: 'u1', displayName: 'billy', file: 'billy-u1.ogg', t: T0 + 1000, deltaMs: 1000 }),
  L({ v: 1, type: 'speech', userId: 'u1', t: T0 + 2000, trackMs: 1000 }),
  L({ v: 1, type: 'leave', userId: 'u1', t: T0 + 5000 }),
  L({ v: 1, type: 'future-thing', x: 1 }),
  '{ not json',
  L({ v: 1, type: 'reconnect', userId: 'u1', t: T0 + 800_000 }),
  L({ v: 1, type: 'track', userId: 'u1', displayName: 'billy', file: 'billy-u1-2.ogg', t: T0 + 800_000, deltaMs: 800_000 }),
].join('\n');

test('readTimeline: t0, tracks and lifecycles; no per-burst data; corrupt/unknown lines skipped', () => {
  const tl = readTimeline(fixture);
  assert.equal(tl.t0, T0);
  assert.deepEqual(tl.tracks.map((t) => t.file), ['billy-u1.ogg', 'billy-u1-2.ogg']);
  assert.deepEqual(Object.keys(tl.tracks[0]).sort(), ['deltaMs', 'displayName', 'file', 't', 'userId']);
  assert.deepEqual(tl.lifecycles.map((e) => e.type), ['leave', 'reconnect']);
  assert.equal('burstsByFile' in tl, false);
});

test('readTimeline: empty / absent / non-string input returns null', () => {
  assert.equal(readTimeline(''), null);
  assert.equal(readTimeline('   \n'), null);
  assert.equal(readTimeline(undefined), null);
  assert.equal(readTimeline(null), null);
});

test('rejoinNotes: one note per display name spanning more than one track, at the later track meeting time', () => {
  const notes = rejoinNotes(readTimeline(fixture));
  assert.deepEqual(notes, [
    '_billy: 2 tracks in this meeting (left and rejoined at 13:20); lines are merged under one label._',
  ]);
});

test('rejoinNotes: no timeline or no repeats yields no notes', () => {
  assert.deepEqual(rejoinNotes(null), []);
  const one = readTimeline(L({ type: 'track', userId: 'a', displayName: 'a', file: 'a.ogg', t: 1, deltaMs: 0 }));
  assert.deepEqual(rejoinNotes(one), []);
});
