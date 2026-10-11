import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakingGate } from '../src/speaking-gate.js';

function fakeTimers() {
  /** @type {{ id: number, due: number, fn: Function }[]} */
  const q = [];
  let now = 0;
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      q.push({ id, due: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      const i = q.findIndex((t) => t.id === id);
      if (i >= 0) q.splice(i, 1);
    },
    advance(ms) {
      now += ms;
      q.sort((a, b) => a.due - b.due);
      while (q.length && q[0].due <= now) {
        const t = q.shift();
        t.fn();
      }
    },
  };
}

function activePacket() {
  return Buffer.alloc(80, 1);
}

function noisePacket() {
  return Buffer.alloc(10, 1);
}

describe('SpeakingGate', () => {
  it('does not log start until confirmMs + enough active packets', () => {
    const timers = fakeTimers();
    const started = [];
    const gate = new SpeakingGate({
      confirmMs: 1000,
      minActivePackets: 5,
      minPacketBytes: 40,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onStarted: (id, name) => started.push(`${name}:${id}`),
    });

    gate.speakingStart('u1', 'Alice');
    for (let i = 0; i < 5; i++) gate.onPacket('u1', activePacket());
    timers.advance(999);
    assert.equal(started.length, 0);
    timers.advance(1);
    assert.deepEqual(started, ['Alice:u1']);
  });

  it('ignores tiny packets toward activity', () => {
    const timers = fakeTimers();
    const started = [];
    const gate = new SpeakingGate({
      confirmMs: 1000,
      minActivePackets: 5,
      minPacketBytes: 40,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onStarted: (id, name) => started.push(name),
    });

    gate.speakingStart('u1', 'Alice');
    for (let i = 0; i < 20; i++) gate.onPacket('u1', noisePacket());
    timers.advance(1000);
    assert.equal(started.length, 0);
  });

  it('cancels start if speaking ends before confirm', () => {
    const timers = fakeTimers();
    const started = [];
    const gate = new SpeakingGate({
      confirmMs: 1000,
      minActivePackets: 1,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onStarted: (_id, name) => started.push(name),
    });

    gate.speakingStart('u1', 'Alice');
    gate.onPacket('u1', activePacket());
    timers.advance(500);
    gate.speakingEnd('u1');
    timers.advance(1000);
    assert.equal(started.length, 0);
  });

  it('logs stop only after silenceMs once confirmed', () => {
    const timers = fakeTimers();
    const events = [];
    const gate = new SpeakingGate({
      confirmMs: 1000,
      silenceMs: 1000,
      minActivePackets: 1,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onStarted: (_id, name) => events.push(`start:${name}`),
      onStopped: (_id, name) => events.push(`stop:${name}`),
    });

    gate.speakingStart('u1', 'Alice');
    gate.onPacket('u1', activePacket());
    timers.advance(1000);
    assert.deepEqual(events, ['start:Alice']);

    gate.speakingEnd('u1');
    timers.advance(999);
    assert.deepEqual(events, ['start:Alice']);
    timers.advance(1);
    assert.deepEqual(events, ['start:Alice', 'stop:Alice']);
  });

  it('flicker end/start within silenceMs does not log stop', () => {
    const timers = fakeTimers();
    const events = [];
    const gate = new SpeakingGate({
      confirmMs: 1000,
      silenceMs: 1000,
      minActivePackets: 1,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onStarted: (_id, name) => events.push(`start:${name}`),
      onStopped: (_id, name) => events.push(`stop:${name}`),
    });

    gate.speakingStart('u1', 'Alice');
    gate.onPacket('u1', activePacket());
    timers.advance(1000);

    gate.speakingEnd('u1');
    timers.advance(200);
    gate.speakingStart('u1', 'Alice');
    timers.advance(1000);
    assert.deepEqual(events, ['start:Alice']);
  });
});
