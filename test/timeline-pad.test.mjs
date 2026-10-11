import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gapFrames, FRAME_MS, GAP_THRESHOLD_MS } from '../src/timeline-pad.js';

describe('gapFrames', () => {
  it('exports the grid constants', () => {
    assert.equal(FRAME_MS, 20);
    assert.equal(GAP_THRESHOLD_MS, 40);
  });
  it('a 2 s gap is 99 pad frames (previous packet covered its own slot)', () => {
    assert.equal(gapFrames({ prevAtMs: 1000, atMs: 3000 }), 99);
  });
  it('below the 40 ms threshold is jitter: 0', () => {
    assert.equal(gapFrames({ prevAtMs: 1000, atMs: 1030 }), 0);
  });
  it('exactly at the threshold is not above it: 0', () => {
    assert.equal(gapFrames({ prevAtMs: 1000, atMs: 1040 }), 0);
  });
  it('rounds to the nearest whole frame (2051 ms -> 103 slots -> 102)', () => {
    assert.equal(gapFrames({ prevAtMs: 1000, atMs: 3051 }), 102);
  });
  it('a backwards clock yields 0', () => {
    assert.equal(gapFrames({ prevAtMs: 3000, atMs: 1000 }), 0);
  });
});
