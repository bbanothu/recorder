import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createClipsStore } from '../mobile/src/core/clips-store.js';

// Same pattern as src/phone/store.js: DI'd on a DatabaseSync-shaped db so the
// identical code runs against node:sqlite here and expo-sqlite on the phone.

function store(now = () => new Date('2026-10-08T12:00:00.000Z')) {
  return createClipsStore(new DatabaseSync(':memory:'), { now });
}

test('createClip: assigns an id, lists newest first, reads back', () => {
  const s = store();
  const a = s.createClip({ fromMs: 1000, toMs: 2000, dir: 'clips/1', chunkCount: 2 });
  const b = s.createClip({ fromMs: 3000, toMs: 4000, dir: 'clips/2', chunkCount: 1 });
  assert.equal(typeof a, 'number');
  assert.deepEqual(
    s.listClips().map((c) => c.id),
    [b, a],
  );
  assert.deepEqual(s.getClip(a), {
    id: a,
    fromMs: 1000,
    toMs: 2000,
    dir: 'clips/1',
    chunkCount: 2,
    createdAt: '2026-10-08T12:00:00.000Z',
  });
});

test('getClip: unknown id is null', () => {
  assert.equal(store().getClip(999), null);
});

test('deleteClip: removes it; listing and re-reading reflect that', () => {
  const s = store();
  const a = s.createClip({ fromMs: 1, toMs: 2, dir: 'd', chunkCount: 1 });
  s.deleteClip(a);
  assert.equal(s.getClip(a), null);
  assert.deepEqual(s.listClips(), []);
});
