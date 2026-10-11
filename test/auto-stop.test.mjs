import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAutoStop,
  isActivityPacket,
  AUTO_STOP_ACTIVITY_FLOOR_BYTES,
} from '../src/auto-stop.js';

const MIN = 60_000;
const base = {
  nowMs: 100 * MIN,           // 100 min "clock"
  joinedAtMs: 94 * MIN,       // 6 min in channel
  lastActivityAtMs: 94 * MIN, // activity 6 min ago
  humanCount: 2,
  thresholdMs: 5 * MIN,
};

describe('evaluateAutoStop', () => {
  it('stops on empty channel after threshold', () => {
    const r = evaluateAutoStop({ ...base, humanCount: 0 });
    assert.equal(r.stop, true);
    assert.match(r.reason, /everyone left/);
  });

  it('stops on activity silence after threshold', () => {
    const r = evaluateAutoStop({ ...base, humanCount: 1 });
    assert.equal(r.stop, true);
    assert.match(r.reason, /no voice activity/);
  });

  it('does NOT stop before 5 min in channel', () => {
    const r = evaluateAutoStop({ ...base, joinedAtMs: 97 * MIN, lastActivityAtMs: 90 * MIN, humanCount: 0 });
    assert.equal(r.stop, false);
  });

  it('does NOT stop when humans present AND active', () => {
    const r = evaluateAutoStop({ ...base, lastActivityAtMs: 99 * MIN });
    assert.equal(r.stop, false);
  });

  it('empty-channel AND silence: prefers everyone-left reason', () => {
    const r = evaluateAutoStop({ ...base, humanCount: 0 });
    assert.match(r.reason, /everyone left/);
  });

  it('activity exactly at threshold counts as silent', () => {
    const r = evaluateAutoStop({ ...base, lastActivityAtMs: 95 * MIN }); // exactly 5 min
    assert.equal(r.stop, true);
  });
});

describe('isActivityPacket', () => {
  it('comfort-noise frame (3-10 B) does not count as activity', () => {
    assert.equal(isActivityPacket(Buffer.alloc(8), 16), false);
  });

  it('frame at/above floor counts', () => {
    assert.equal(isActivityPacket(Buffer.alloc(16), 16), true);
    assert.equal(isActivityPacket(Buffer.alloc(60), 16), true);
  });

  it('empty/missing packet does not count', () => {
    assert.equal(isActivityPacket(null, 16), false);
    assert.equal(isActivityPacket(Buffer.alloc(0), 16), false);
  });

  it('default floor is AUTO_STOP_ACTIVITY_FLOOR_BYTES', () => {
    assert.equal(AUTO_STOP_ACTIVITY_FLOOR_BYTES, 16);
    assert.equal(isActivityPacket(Buffer.alloc(15)), false);
    assert.equal(isActivityPacket(Buffer.alloc(16)), true);
  });
});
