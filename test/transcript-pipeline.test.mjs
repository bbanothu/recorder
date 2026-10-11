import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeTargets, writeTranscript } from '../src/transcript-pipeline.js';

const target = (path, displayName, startedAtMs) => ({ path, displayName, startedAtMs });

test('transcribeTargets: keeps fulfilled tracks in target order with their metadata', async () => {
  const lines = [];
  const tracks = await transcribeTargets({
    targets: [target('/m/Alice-1.ogg', 'Alice', 1000), target('/m/Bob-2.ogg', 'Bob', 2000)],
    transcribe: async ({ masterPath }) => ({
      segments: [{ start: 0, end: 1, text: `hi from ${masterPath}` }],
      language: 'en',
    }),
    log: (m) => lines.push(m),
  });
  assert.deepEqual(
    tracks.map((t) => [t.displayName, t.startedAtMs, t.file, t.language, t.segments.length]),
    [
      ['Alice', 1000, 'Alice-1.ogg', 'en', 1],
      ['Bob', 2000, 'Bob-2.ogg', 'en', 1],
    ],
  );
  assert.deepEqual(lines, ['transcribed Alice-1.ogg: 1 segments', 'transcribed Bob-2.ogg: 1 segments']);
});

test('transcribeTargets: passes transcribeOpts through and the track path as masterPath', async () => {
  const calls = [];
  await transcribeTargets({
    targets: [target('/m/A.ogg', 'A', 0)],
    transcribe: async (opts) => {
      calls.push(opts);
      return { segments: [] };
    },
    transcribeOpts: { model: 'base' },
    log: () => {},
  });
  assert.deepEqual(calls, [{ model: 'base', masterPath: '/m/A.ogg' }]);
});

test('transcribeTargets: one failing track is logged and dropped; the rest survive', async () => {
  const lines = [];
  const tracks = await transcribeTargets({
    targets: [target('/m/A.ogg', 'A', 0), target('/m/B.ogg', 'B', 0)],
    transcribe: async ({ masterPath }) => {
      if (masterPath.endsWith('A.ogg')) throw new Error('boom');
      return { segments: [] };
    },
    log: (m) => lines.push(m),
  });
  assert.deepEqual(tracks.map((t) => t.file), ['B.ogg']);
  assert.deepEqual(lines, [
    'transcription failed for A.ogg (boom); audio already delivered',
    'no speech recognized in B.ogg (0 segments) — audio kept',
  ]);
});

test('transcribeTargets: all failing → empty list, no success lines', async () => {
  const lines = [];
  const tracks = await transcribeTargets({
    targets: [target('/m/A.ogg', 'A', 0)],
    transcribe: async () => {
      throw new Error('x');
    },
    log: (m) => lines.push(m),
  });
  assert.deepEqual(tracks, []);
  assert.equal(lines.length, 1);
});

test('writeTranscript: writes the combined markdown beside the session and reports counts', async () => {
  const writes = [];
  const out = await writeTranscript({
    dir: '/m/meeting-x',
    sessionStartMs: Date.UTC(2026, 9, 4, 12, 0, 0),
    tracks: [
      { displayName: 'Alice', startedAtMs: Date.UTC(2026, 9, 4, 12, 0, 0), file: 'A.ogg', segments: [{ start: 1, text: 'hello' }, { start: 2, text: 'again' }] },
      { displayName: 'Bob', startedAtMs: Date.UTC(2026, 9, 4, 12, 0, 0), file: 'B.ogg', segments: [] },
    ],
    rejoinNotes: ['_note_'],
    writeFile: async (...args) => writes.push(args),
  });
  assert.equal(out.mdPath, '/m/meeting-x/transcript-2026-10-04_12-00.md');
  assert.equal(out.segmentCount, 2);
  assert.equal(out.withSpeech, 1);
  assert.equal(writes.length, 1);
  const [path, md, enc] = writes[0];
  assert.equal(path, out.mdPath);
  assert.equal(enc, 'utf8');
  assert.match(md, /\[00:01\] \*\*Alice:\*\* hello/);
  assert.match(md, /No speech recognized for \*\*Bob\*\* \(B\.ogg\)/);
  assert.match(md, /_note_/);
});
