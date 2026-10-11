import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipTranscriptFileName,
  needsTranscription,
  renderClipMarkdown,
  transcriptionProgress,
} from '../mobile/src/core/local-transcript.js';

const T = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;

test('clipTranscriptFileName: MM-DD-YYYY, both clock times, UTC — matches the server\'s phone-clip naming', () => {
  assert.equal(
    clipTranscriptFileName(Date.UTC(2026, 9, 10, 15, 33), Date.UTC(2026, 9, 10, 15, 48)),
    'clip_10-10-2026_1533-1548-UTC.md',
  );
});

test('renderClipMarkdown: stitches segments across chunks onto one absolute clock, in order', () => {
  const md = renderClipMarkdown({
    fromMs: T,
    toMs: T + 2 * MIN,
    chunks: [
      { startedAt: T, durationMs: MIN, sidecar: { language: 'en', segments: [{ text: ' hello ', t0: 0, t1: 150 }] } },
      { startedAt: T + MIN, durationMs: MIN, sidecar: { language: 'en', segments: [{ text: 'world', t0: 500, t1: 600 }] } },
    ],
  });
  assert.match(md, /language: en/);
  assert.match(md, /\[00:00:00\] hello/);
  assert.match(md, /\[00:01:05\] world/); // chunk started 1 min in + t0=500cs=5s
  assert.ok(md.indexOf('hello') < md.indexOf('world'));
});

test('renderClipMarkdown: a chunk with no sidecar yet is marked pending, not silently dropped', () => {
  const md = renderClipMarkdown({
    fromMs: T,
    toMs: T + MIN,
    chunks: [{ startedAt: T, durationMs: MIN, sidecar: null }],
  });
  assert.match(md, /not transcribed yet/);
});

test('renderClipMarkdown: a chunk whose transcription failed says so', () => {
  const md = renderClipMarkdown({
    fromMs: T,
    toMs: T + MIN,
    chunks: [{ startedAt: T, durationMs: MIN, sidecar: { error: 'boom' } }],
  });
  assert.match(md, /transcription failed: boom/);
});

test('renderClipMarkdown: blank/whitespace-only segments are dropped', () => {
  const md = renderClipMarkdown({
    fromMs: T,
    toMs: T + MIN,
    chunks: [{ startedAt: T, durationMs: MIN, sidecar: { segments: [{ text: '   ', t0: 0, t1: 10 }] } }],
  });
  assert.match(md, /No speech recognized/);
});

test('needsTranscription: no sidecar yet, or the last attempt failed, both mean "try it"', () => {
  assert.equal(needsTranscription(null), true);
  assert.equal(needsTranscription({ error: 'native module could not be found' }), true);
  assert.equal(needsTranscription({ language: 'en', segments: [] }), false);
});

test('transcriptionProgress: counts chunks with a sidecar (done or failed) vs still pending', () => {
  assert.deepEqual(
    transcriptionProgress([{ sidecar: { segments: [] } }, { sidecar: { error: 'x' } }, { sidecar: null }]),
    { done: 2, total: 3 },
  );
});
