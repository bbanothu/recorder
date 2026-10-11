import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TIMELINE_VERSION,
  sessionEvent,
  trackEvent,
  speechEvent,
  lifecycleEvent,
  endEvent,
  appendTimelineEvent,
} from '../src/timeline.js';

describe('timeline events', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-tl-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('TIMELINE_VERSION is 1 and every builder stamps v + type', () => {
    assert.equal(TIMELINE_VERSION, 1);
    const all = [
      sessionEvent({ t0: 1, guildId: 'g', botUserId: 'b', dir: '/d', version: '3.0.2' }),
      trackEvent({ userId: 'u', displayName: 'A', file: 'a.ogg', t: 5, t0: 1 }),
      speechEvent({ userId: 'u', t: 6, trackMs: 40 }),
      lifecycleEvent('join', { userId: 'u', t: 7 }),
      lifecycleEvent('leave', { userId: 'u', t: 8 }),
      lifecycleEvent('reconnect', { userId: 'u', t: 9 }),
      endEvent({ t: 10, t0: 1, durationMs: 9 }),
    ];
    assert.deepEqual(all.map((e) => e.type), ['session', 'track', 'speech', 'join', 'leave', 'reconnect', 'end']);
    for (const e of all) assert.equal(e.v, 1);
  });

  it('documented shapes', () => {
    assert.deepEqual(
      sessionEvent({ t0: 1, guildId: 'g', botUserId: 'b', dir: '/d', version: '3.0.2' }),
      { v: 1, type: 'session', t0: 1, guildId: 'g', botUserId: 'b', dir: '/d', version: '3.0.2' },
    );
    const t = trackEvent({ userId: 'u', displayName: 'A', file: 'a.ogg', t: 5000, t0: 1000 });
    assert.equal(t.deltaMs, 4000);
    assert.equal(t.file, 'a.ogg');
    assert.deepEqual(speechEvent({ userId: 'u', t: 6, trackMs: 40 }), { v: 1, type: 'speech', userId: 'u', t: 6, trackMs: 40 });
    assert.deepEqual(lifecycleEvent('leave', { userId: 'u', t: 8 }), { v: 1, type: 'leave', userId: 'u', t: 8 });
    assert.deepEqual(endEvent({ t: 10, t0: 1, durationMs: 9 }), { v: 1, type: 'end', t: 10, t0: 1, durationMs: 9 });
  });

  it('lifecycleEvent rejects unknown kinds', () => {
    assert.throws(() => lifecycleEvent('nope', { userId: 'u', t: 1 }));
  });

  it('appendTimelineEvent appends exactly one newline-terminated line each call', () => {
    const p = join(root, 't.jsonl');
    assert.equal(appendTimelineEvent(p, { a: 1 }), true);
    assert.equal(appendTimelineEvent(p, { b: 2 }), true);
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n{"b":2}\n');
  });

  it('appendTimelineEvent never throws: unwritable path -> false + onError', () => {
    const blocker = join(root, 'file');
    writeFileSync(blocker, 'x');
    const errs = [];
    const ok = appendTimelineEvent(join(blocker, 'sub', 't.jsonl'), { a: 1 }, (e) => errs.push(e));
    assert.equal(ok, false);
    assert.equal(errs.length, 1);
    assert.equal(appendTimelineEvent(join(blocker, 'sub', 't.jsonl'), { a: 1 }), false);
  });
});
