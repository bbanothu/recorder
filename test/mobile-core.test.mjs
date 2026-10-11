import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkFileName,
  parseChunkFileName,
  uploadOrder,
  expiredChunkNames,
  chunksOverlapping,
  clipRange,
  WINDOW_CHOICES,
} from '../mobile/src/core/chunks.js';
import { normalizeSettings, newDeviceId } from '../mobile/src/core/settings.js';
import { createApi } from '../mobile/src/core/api.js';

const MIN = 60_000;
const T = Date.UTC(2026, 9, 6, 12, 0, 0);

test('chunk file names carry start and duration, and parse back', () => {
  assert.equal(chunkFileName(T, 60_123), `${T}-60123.m4a`);
  assert.deepEqual(parseChunkFileName(`${T}-60123.m4a`), { startedAt: T, durationMs: 60_123 });
  assert.equal(parseChunkFileName('recording-abc.m4a'), null);
  assert.equal(parseChunkFileName(`${T}-0.m4a`), null);
});

test('uploadOrder: oldest first, foreign files ignored', () => {
  assert.deepEqual(uploadOrder([`${T + MIN}-60000.m4a`, 'junk.txt', `${T}-60000.m4a`]), [`${T}-60000.m4a`, `${T + MIN}-60000.m4a`]);
});

test('expiredChunkNames: pending files that ended before now − window are dropped locally', () => {
  const names = [`${T - 40 * MIN}-60000.m4a`, `${T - 20 * MIN}-60000.m4a`];
  assert.deepEqual(expiredChunkNames(names, T, 30), [`${T - 40 * MIN}-60000.m4a`]);
});

test('chunksOverlapping: names whose [startedAt, startedAt+durationMs) intersects the range, oldest first', () => {
  const names = [
    `${T}-${MIN}.m4a`, // [T, T+MIN) — touches the range start, kept
    `${T + MIN}-${MIN}.m4a`, // fully inside
    `${T + 3 * MIN}-${MIN}.m4a`, // starts at the range end — excluded (half-open)
    'junk.txt',
  ];
  assert.deepEqual(chunksOverlapping(names, T, T + 3 * MIN), [`${T}-${MIN}.m4a`, `${T + MIN}-${MIN}.m4a`]);
});

test('clipRange: last N minutes, never longer than the window; "all" = the whole window', () => {
  assert.deepEqual(clipRange(15, T, 60), { fromMs: T - 15 * MIN, toMs: T });
  assert.deepEqual(clipRange(60, T, 30), { fromMs: T - 30 * MIN, toMs: T });
  assert.deepEqual(clipRange('all', T, 720), { fromMs: T - 720 * MIN, toMs: T });
  assert.deepEqual(WINDOW_CHOICES.map((w) => w.minutes), [30, 60, 720]);
});

test('normalizeSettings: trims, strips a trailing slash, and explains what is missing', () => {
  assert.deepEqual(
    normalizeSettings({ serverUrl: ' http://100.75.51.90:8787/ ', token: ' abc ', deviceId: 'pixel-1' }),
    { ok: true, settings: { serverUrl: 'http://100.75.51.90:8787', token: 'abc', deviceId: 'pixel-1' } },
  );
  assert.deepEqual(normalizeSettings({ serverUrl: 'ftp://x', token: '', deviceId: 'bad id!' }), {
    ok: false,
    errors: ['Server URL must start with http:// or https://', 'Token is required', 'Device id: 1-64 of A-Z a-z 0-9 _ -'],
  });
});

test('newDeviceId: "phone-" plus 8 hex characters from the given random source', () => {
  assert.equal(newDeviceId(() => 0.5), 'phone-88888888');
  assert.match(newDeviceId(), /^phone-[0-9a-f]{8}$/);
});

test('createApi: bearer auth, JSON in and out, readable errors', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([url, init.method ?? 'GET', init.headers.authorization, init.body ?? null]);
    if (url.endsWith('/clips/9')) return { ok: false, status: 404, json: async () => ({ error: 'No such clip' }) };
    return { ok: true, status: 200, json: async () => ({ echoed: true }) };
  };
  const api = createApi({ serverUrl: 'http://h:1', token: 'tok', deviceId: 'pixel', fetch: fetchFn });
  await api.setWindow(30);
  await api.createClip({ fromMs: 1, toMs: 2 });
  await api.listClips();
  await assert.rejects(api.getClip(9), /404: No such clip/);
  await api.deleteClip(1);
  await api.deleteAllClips();
  await api.translateClip(1);
  await api.redoClip(1);
  await api.updateClipMarkdown(1, '# edited\n');
  await api.deleteClipAudio(1);
  await api.deleteClipText(1);
  assert.deepEqual(calls, [
    ['http://h:1/v1/devices/pixel', 'PUT', 'Bearer tok', '{"windowMinutes":30}'],
    ['http://h:1/v1/devices/pixel/clips', 'POST', 'Bearer tok', '{"fromMs":1,"toMs":2}'],
    ['http://h:1/v1/devices/pixel/clips', 'GET', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/9', 'GET', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/1', 'DELETE', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips', 'DELETE', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/1/translate', 'POST', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/1/redo', 'POST', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/1/transcript', 'PUT', 'Bearer tok', '{"markdown":"# edited\\n"}'],
    ['http://h:1/v1/devices/pixel/clips/1/audio', 'DELETE', 'Bearer tok', null],
    ['http://h:1/v1/devices/pixel/clips/1/transcript', 'DELETE', 'Bearer tok', null],
  ]);
  assert.equal(api.chunkUrl(T, 60000), `http://h:1/v1/devices/pixel/chunks/${T}?durationMs=60000`);
  assert.deepEqual(api.authHeaders(), { authorization: 'Bearer tok' });
});
