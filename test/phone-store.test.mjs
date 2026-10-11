import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPhoneStore } from '../src/phone/store.js';

const MIN = 60_000;
const T = Date.UTC(2026, 9, 6, 12, 0, 0);
const make = () => createPhoneStore(new DatabaseSync(':memory:'), { now: () => new Date(T), defaultWindowMinutes: 60 });

test('devices: unknown device uses the default window; setWindow persists', () => {
  const s = make();
  assert.equal(s.windowMinutes('pixel'), 60);
  s.setWindow('pixel', 720);
  assert.equal(s.windowMinutes('pixel'), 720);
  assert.equal(s.windowMinutes('other'), 60);
});

test('chunks: addChunk is idempotent per (device, startedAt)', () => {
  const s = make();
  assert.equal(s.addChunk({ deviceId: 'p', startedAt: T, durationMs: MIN, path: '/a.m4a' }), true);
  assert.equal(s.addChunk({ deviceId: 'p', startedAt: T, durationMs: MIN, path: '/a.m4a' }), false);
  assert.equal(s.addChunk({ deviceId: 'q', startedAt: T, durationMs: MIN, path: '/b.m4a' }), true);
  assert.equal(s.chunksInState('received').length, 2);
});

test('chunks: state changes, overlap query in time order', () => {
  const s = make();
  for (let i = 0; i < 4; i++) s.addChunk({ deviceId: 'p', startedAt: T + i * MIN, durationMs: MIN, path: `/${i}.m4a` });
  s.setChunkTranscribed('p', T + MIN, '/1.segments.json');
  s.setChunkFailed('p', T + 2 * MIN);
  const over = s.chunksOverlapping('p', T + MIN + 30_000, T + 3 * MIN);
  assert.deepEqual(
    over.map((c) => [c.startedAt, c.state, c.segmentsPath]),
    [
      [T + MIN, 'transcribed', '/1.segments.json'],
      [T + 2 * MIN, 'failed', null],
    ],
  );
});

test('chunks: expired = ended before now − the device window', () => {
  const s = make();
  s.setWindow('p', 30);
  s.addChunk({ deviceId: 'p', startedAt: T - 40 * MIN, durationMs: MIN, path: '/old.m4a' });
  s.addChunk({ deviceId: 'p', startedAt: T - 30 * MIN, durationMs: MIN, path: '/edge.m4a' });
  s.addChunk({ deviceId: 'q', startedAt: T - 40 * MIN, durationMs: MIN, path: '/q.m4a' }); // 60 min default
  assert.deepEqual(s.expiredChunks(T).map((c) => c.path), ['/old.m4a']);
  s.deleteChunk('p', T - 40 * MIN);
  assert.deepEqual(s.expiredChunks(T), []);
});

test('clips: create pending, finish ready, list newest first', () => {
  const s = make();
  const a = s.createClip({ deviceId: 'p', fromMs: T - 30 * MIN, toMs: T });
  const b = s.createClip({ deviceId: 'p', fromMs: T - 5 * MIN, toMs: T });
  assert.equal(s.getClip('p', a).state, 'pending');
  s.finishClip(a, { mdPath: '/c/t.md', audioPath: '/c/a.m4a' });
  assert.deepEqual(
    (({ state, mdPath, audioPath }) => ({ state, mdPath, audioPath }))(s.getClip('p', a)),
    { state: 'ready', mdPath: '/c/t.md', audioPath: '/c/a.m4a' },
  );
  assert.deepEqual(s.listClips('p').map((c) => c.id), [b, a]);
  assert.deepEqual(s.pendingClips().map((c) => c.id), [b]);
  assert.equal(s.getClip('other', a), null);
});

test('clips: finishClip persists language; setClipTranslation caches a translated markdown path', () => {
  const s = make();
  const a = s.createClip({ deviceId: 'p', fromMs: T, toMs: T + MIN });
  assert.equal(s.getClip('p', a).language, null);
  s.finishClip(a, { mdPath: '/c/t.md', audioPath: '/c/a.m4a', language: 'es' });
  assert.equal(s.getClip('p', a).language, 'es');
  assert.equal(s.getClip('p', a).translatedMdPath, null);
  s.setClipTranslation(a, '/c/t.en.md');
  assert.equal(s.getClip('p', a).translatedMdPath, '/c/t.en.md');
});

test('clips: setClipMdPath/setClipAudioPath/setClipLanguage edit fields independently, null clears', () => {
  const s = make();
  const a = s.createClip({ deviceId: 'p', fromMs: T, toMs: T + MIN });
  s.finishClip(a, { mdPath: '/c/t.md', audioPath: '/c/a.m4a', language: 'es' });

  s.setClipAudioPath(a, null); // "delete audio" — transcript untouched
  assert.deepEqual(
    (({ mdPath, audioPath, language }) => ({ mdPath, audioPath, language }))(s.getClip('p', a)),
    { mdPath: '/c/t.md', audioPath: null, language: 'es' },
  );

  s.setClipMdPath(a, null); // "delete text" — now both gone
  assert.equal(s.getClip('p', a).mdPath, null);

  s.setClipMdPath(a, '/c/t2.md'); // revise/redo writes a fresh one back
  s.setClipLanguage(a, 'en');
  assert.deepEqual(
    (({ mdPath, language }) => ({ mdPath, language }))(s.getClip('p', a)),
    { mdPath: '/c/t2.md', language: 'en' },
  );
});

test('clips: deleteClip removes it (scoped to the device), returns the deleted row or null', () => {
  const s = make();
  const a = s.createClip({ deviceId: 'p', fromMs: T - 30 * MIN, toMs: T });
  s.finishClip(a, { mdPath: '/c/t.md', audioPath: '/c/a.m4a' });
  assert.equal(s.deleteClip('other', a)?.id, undefined); // wrong device: no-op
  assert.ok(s.getClip('p', a));
  const deleted = s.deleteClip('p', a);
  assert.deepEqual(
    (({ id, mdPath, audioPath }) => ({ id, mdPath, audioPath }))(deleted),
    { id: a, mdPath: '/c/t.md', audioPath: '/c/a.m4a' },
  );
  assert.equal(s.getClip('p', a), null);
  assert.equal(s.deleteClip('p', a), null); // already gone
});
