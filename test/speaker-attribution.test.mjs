import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeSegments,
  speechEventsFromCaptionLog,
  tracksFromAttributed,
  tracksFromCaptions,
} from '../src/speaker-attribution.js';

const t0 = 10_000_000; // recording start (absolute ms)

test('speechEventsFromCaptionLog: only growth counts, weighted by the characters added', () => {
  const events = speechEventsFromCaptionLog([
    { t: t0 + 1000, id: '1', name: 'Ana', text: 'hi' },
    { t: t0 + 2000, id: '1', name: 'Ana', text: 'hi there' },
    { t: t0 + 3000, id: '2', name: 'Bo', text: 'yo' },
    // Meet trims or rewords a long-lived entry: no new speech
    { t: t0 + 600_000, id: '1', name: 'Ana', text: 'there' },
  ]);
  assert.deepEqual(events, [
    { name: 'Ana', t: t0 + 1000, weight: 2 },
    { name: 'Ana', t: t0 + 2000, weight: 6 },
    { name: 'Bo', t: t0 + 3000, weight: 2 },
  ]);
});

test('attributeSegments: the speaker whose captions grew most during the segment (plus caption lag), else null', () => {
  const events = [
    { name: 'Ana', t: t0 + 1500, weight: 20 },
    { name: 'Bo', t: t0 + 4000, weight: 5 },
    { name: 'Bo', t: t0 + 5500, weight: 30 },
    { name: 'Ana', t: t0 + 6000, weight: 4 },
  ];
  const segs = [
    { start: 0.5, end: 2.5, text: 'a' }, // Ana's growth lands inside
    { start: 3.2, end: 5.0, text: 'b' }, // window to 7.0 s: Bo 35 vs Ana 4 → Bo
    { start: 60, end: 62, text: 'c' }, // nobody within reach
  ];
  assert.deepEqual(
    attributeSegments(segs, events, { recordingStartMs: t0, lagMs: 2000 }).map((s) => s.speaker),
    ['Ana', 'Bo', null],
  );
});

test('attributeSegments: a segment with no growth inside its window takes the nearest event within 10 s', () => {
  const events = [{ name: 'Bo', t: t0 + 20_000, weight: 3 }];
  const segs = [{ start: 12, end: 13, text: 'x' }];
  assert.equal(attributeSegments(segs, events, { recordingStartMs: t0, lagMs: 2000 })[0].speaker, 'Bo');
});

test('tracksFromAttributed: one track per speaker (null = unnamed), all anchored at the recording start', () => {
  const tracks = tracksFromAttributed(
    [
      { start: 1, end: 2, text: 'a', speaker: 'Ana' },
      { start: 3, end: 4, text: 'b', speaker: 'Bo' },
      { start: 5, end: 6, text: 'c', speaker: 'Ana' },
      { start: 7, end: 8, text: 'd', speaker: null },
    ],
    { recordingStartMs: t0, language: 'en' },
  );
  assert.deepEqual(
    tracks.map((t) => [t.displayName, t.startedAtMs, t.segments.map((s) => s.text), t.language]),
    [
      ['Ana', t0, ['a', 'c'], 'en'],
      ['Bo', t0, ['b'], 'en'],
      [null, t0, ['d'], 'en'],
    ],
  );
});

test('tracksFromCaptions: the captions alone become a transcript when Whisper is unavailable', () => {
  const tracks = tracksFromCaptions(
    [
      { id: '1', name: 'Ana', text: ' hello there ', firstMs: t0 + 2000, lastMs: t0 + 4000 },
      { id: '2', name: 'Bo', text: '', firstMs: t0 + 5000, lastMs: t0 + 5000 },
      { id: '3', name: 'Ana', text: 'bye', firstMs: t0 + 9000, lastMs: t0 + 9500 },
    ],
    { recordingStartMs: t0 },
  );
  assert.deepEqual(
    tracks.map((t) => [t.displayName, t.segments.map((s) => [s.start, s.text])]),
    [['Ana', [[2, 'hello there'], [9, 'bye']]]],
  );
});
