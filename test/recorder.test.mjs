import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { Recorder } from '../src/recorder.js';
import { muxOpusToOgg } from '../src/ogg-mux.js';

function fakePacket(n = 20) {
  return Buffer.alloc(n, 0xfc);
}

function fakeSubscribe() {
  return new PassThrough();
}

function filesMatching(dir, prefix) {
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.ogg'));
}

describe('Recorder', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-rec-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('addUser/removeUser/stop: leaver file before stop; never-spoken skipped', () => {
    let tick = 0;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T21:04:33Z'),
      mux: muxOpusToOgg,
      now: () => new Date(Date.UTC(2026, 8, 18, 21, 4, 33, tick++)),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });

    const { dir } = recorder.start();

    recorder.addUser({ id: 'bot1', displayName: 'Bot' });
    assert.equal(streams.size, 0);

    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    recorder.addUser({ id: 'u2', displayName: 'Bob' });
    streams.get('u1').push(fakePacket(30));
    streams.get('u1').push(fakePacket(30));
    streams.get('u2').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.markConfirmed('u2');

    recorder.removeUser('u1');
    const aliceFiles = filesMatching(dir, 'Alice-');
    assert.equal(aliceFiles.length, 1);
    const alice = join(dir, aliceFiles[0]);
    assert.ok(existsSync(alice), 'leaver file exists before stop');
    const aliceSize = statSync(alice).size;
    assert.ok(aliceSize > 0);

    recorder.addUser({ id: 'u3', displayName: 'Carol' });
    streams.get('u3').push(fakePacket(30));
    recorder.markConfirmed('u3');

    recorder.addUser({ id: 'u4', displayName: 'Dave' }); // never speaks / never confirmed

    const result = recorder.stop();
    assert.equal(result.dir, dir);
    assert.equal(filesMatching(dir, 'Bob-').length, 1);
    assert.equal(filesMatching(dir, 'Carol-').length, 1);
    assert.equal(filesMatching(dir, 'Dave-').length, 0);
    assert.equal(result.files.length, 3);
    assert.ok(result.files.includes(alice));
    assert.equal(statSync(alice).size, aliceSize);
    assert.equal(readFileSync(alice).subarray(0, 4).toString(), 'OggS');
  });

  it('start() nests the session dir under the recorder guildId', () => {
    const guildId = '123456789012345678';
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId,
      startedAt: new Date('2026-09-22T01:02:03Z'),
      subscribe: () => fakeSubscribe(),
    });
    const { dir } = recorder.start();
    assert.equal(
      dir,
      join(root, 'discord-meetings', guildId, 'meeting-2026-09-22-01-02-03'),
    );
    assert.ok(dir.endsWith(join(guildId, 'meeting-2026-09-22-01-02-03')));
  });

  it('keeps a never-confirmed track: the speaking gate is log-only', () => {
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T21:10:00Z'),
      mux: muxOpusToOgg,
      now: () => new Date('2026-09-18T21:10:00.000Z'),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let result;
    try {
      recorder.removeUser('u1'); // markConfirmed is never called
      result = recorder.stop();
    } finally {
      console.log = orig;
    }
    const found = filesMatching(dir, 'Alice-');
    assert.equal(found.length, 1);
    assert.ok(statSync(join(dir, found[0])).size > 0, 'the track is not empty');
    assert.equal(result.files.length, 1);
    assert.equal(result.userFiles.length, 1);
    assert.ok(result.userFiles[0].frames > 0, 'frame count carried');
    assert.ok(
      !lines.some((l) => l.includes('discarded')),
      `no discarded line: ${lines.join(' | ')}`,
    );
  });
  it('same display name users get distinct timestamped files', () => {
    let tick = 0;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T22:00:00Z'),
      mux: muxOpusToOgg,
      now: () => new Date(Date.UTC(2026, 8, 18, 22, 0, 0, tick++)),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();
    recorder.addUser({ id: '111111111111111111', displayName: 'Alex' });
    recorder.addUser({ id: '222222222222222222', displayName: 'Alex' });
    streams.get('111111111111111111').push(fakePacket());
    streams.get('222222222222222222').push(fakePacket());
    recorder.markConfirmed('111111111111111111');
    recorder.markConfirmed('222222222222222222');
    const { files } = recorder.stop();
    assert.equal(files.length, 2);
    const alex = filesMatching(dir, 'Alex-');
    assert.equal(alex.length, 2);
    assert.notEqual(alex[0], alex[1]);
  });

  it('rejoin after leave creates a second unique file', () => {
    let tick = 0;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T22:30:00Z'),
      mux: muxOpusToOgg,
      now: () => new Date(Date.UTC(2026, 8, 18, 22, 30, 0, tick++)),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();

    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');

    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');

    const alice = filesMatching(dir, 'Alice-');
    assert.equal(alice.length, 2);
    assert.notEqual(alice[0], alice[1]);
    const { files } = recorder.stop();
    assert.equal(files.length, 2);
  });

  it('empty session → zero files', () => {
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T23:00:00Z'),
      mux: muxOpusToOgg,
      subscribe: () => fakeSubscribe(),
    });
    recorder.start();
    assert.deepEqual(recorder.stop().files, []);
  });

  it('writePerUserFiles=false forwards packets but writes no user files', () => {
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    /** @type {Buffer[]} */
    const forwarded = [];
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T23:30:00Z'),
      mux: muxOpusToOgg,
      writePerUserFiles: false,
      onPacket: (_id, pkt) => forwarded.push(pkt),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');
    assert.equal(forwarded.length, 1);
    assert.equal(filesMatching(dir, 'Alice-').length, 0);
    assert.deepEqual(recorder.stop().files, []);
  });

  it('pads packet gaps with silence so the track keeps the meeting timeline', () => {
    const t0 = Date.UTC(2026, 8, 18, 23, 0, 0);
    let clock = t0;
    const sil = Buffer.from([0xf8, 0xff, 0xfe, 0x00]);
    /** @type {Buffer[][]} */
    const muxed = [];
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0),
      mux: (packets) => {
        muxed.push(packets);
        return Buffer.alloc(4);
      },
      now: () => new Date(clock),
      silenceFrame: sil,
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    recorder.markConfirmed('u1');
    const push = (at) => {
      clock = at;
      streams.get('u1').push(fakePacket(30));
    };
    push(t0);
    push(t0 + 20);
    push(t0 + 2020);
    const result = recorder.stop();
    assert.equal(muxed[0].length, 3 + 99);
    assert.equal(result.userFiles[0].frames, 102);
    assert.equal(result.userFiles[0].speechFrames, 3);
    // one shared reference, not 99 allocations
    const pads = muxed[0].filter((b) => b === sil);
    assert.equal(pads.length, 99);
    assert.equal(muxed[0][2], sil);
    assert.notEqual(muxed[0][101], sil);
  });

  it('a throwing onPacket hook never escapes the voice data callback (track still written)', () => {
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date('2026-09-18T22:45:00Z'),
      mux: muxOpusToOgg,
      // v3.0.0: this is bot.js's onPacket → master.push(), which can throw
      // (unbounded allocation) for every session now.
      onPacket: () => {
        throw new Error('master mix allocation failed');
      },
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    recorder.markConfirmed('u1');

    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    let result;
    try {
      // The consumer throwing must not propagate into the stream's 'data' emit.
      assert.doesNotThrow(() => {
        streams.get('u1').push(fakePacket(30));
        streams.get('u1').push(fakePacket(30));
      });
      result = recorder.stop();
    } finally {
      console.log = orig;
    }

    // The per-user track is the product: it survives the hook failure.
    assert.equal(result.files.length, 1);
    assert.ok(existsSync(result.files[0]));
    assert.equal(filesMatching(dir, 'Alice-').length, 1);
    const logged = lines.filter((l) => /packet hook/i.test(l));
    assert.equal(logged.length, 1, `logged once: ${lines.join(' | ')}`);
    assert.match(logged[0], /u1/);
  });

  // --- Task 1 (1.7.0): userFiles metadata + session startedAtMs ----------

  it('start() returns startedAtMs === its internal now() clock read (fake now; Decision 7 zero)', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 18, 0, 0, 123);
    let calls = 0;
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      now: () => {
        calls += 1;
        return new Date(t0Ms);
      },
      subscribe: () => fakeSubscribe(),
    });
    // bot.js feeds master.start() from THIS value; it must equal the recorder's
    // own internal clock read, not a second independent read.
    const info = recorder.start();
    assert.equal(calls, 1, 'start() performs exactly one now() read');
    assert.equal(info.startedAtMs, t0Ms);
    // stop() replays the SAME single-read value (never a fresh clock read).
    assert.equal(recorder.stop().startedAtMs, t0Ms);
    // v3.0.2 D4: stop() reads the clock once, for the timeline `end` event only.
    assert.equal(calls, 2);
  });

  it('userFiles: path, displayName, startedAtMs (fake clock), frames counted at finalize', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 12, 0, 0, 0);
    let clockMs = t0Ms;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      now: () => new Date(clockMs),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    const { dir } = recorder.start();

    recorder.addUser({ id: 'u1', displayName: 'A' });
    streams.get('u1').push(fakePacket(30));
    streams.get('u1').push(fakePacket(30));
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');

    clockMs = t0Ms + 10 * 60_000;
    recorder.addUser({ id: 'u2', displayName: 'B' });
    streams.get('u2').push(fakePacket(30));
    recorder.markConfirmed('u2');

    const result = recorder.stop();
    assert.equal(result.startedAtMs, t0Ms);
    assert.deepEqual(
      result.userFiles.map((e) => ({
        displayName: e.displayName,
        startedAtMs: e.startedAtMs,
        frames: e.frames,
      })),
      [
        { displayName: 'A', startedAtMs: t0Ms, frames: 3 },
        { displayName: 'B', startedAtMs: t0Ms + 600_000, frames: 1 },
      ],
    );
    assert.ok(result.userFiles.every((e) => typeof e.path === 'string' && e.path.endsWith('.ogg')));
    assert.deepEqual(result.userFiles.map((e) => e.path), result.files);
    assert.ok(Array.isArray(result.files) && result.files.every((f) => typeof f === 'string'));
    assert.equal(result.files.length, 2);
    assert.equal(result.dir, dir);
  });

  it('userFiles includes every user who emitted audio, mirroring files', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 13, 0, 0, 0);
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      now: () => new Date(t0Ms),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Ghost' }); // never speaks: no audio, no file
    recorder.addUser({ id: 'u3', displayName: 'Quiet' }); // audio but never confirmed: kept
    streams.get('u3').push(fakePacket(30));
    recorder.addUser({ id: 'u2', displayName: 'Real' });
    streams.get('u2').push(fakePacket(30));
    recorder.markConfirmed('u2');
    const result = recorder.stop();
    assert.deepEqual(result.userFiles.map((e) => e.displayName).sort(), ['Quiet', 'Real']);
    assert.deepEqual(result.files.map((p) => p.split(/[\\/]/).pop().split('-')[0]).sort(), ['Quiet', 'Real']);
  });

  it('rejoin: same user twice → two userFiles entries, same name, distinct startedAtMs', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 14, 0, 0, 0);
    let clockMs = t0Ms;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      now: () => new Date(clockMs),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();

    recorder.addUser({ id: 'u1', displayName: 'A' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');

    clockMs = t0Ms + 5_000;
    recorder.addUser({ id: 'u1', displayName: 'A' });
    streams.get('u1').push(fakePacket(30));
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');

    const result = recorder.stop();
    assert.deepEqual(
      result.userFiles.map((e) => ({ displayName: e.displayName, startedAtMs: e.startedAtMs, frames: e.frames })),
      [
        { displayName: 'A', startedAtMs: t0Ms, frames: 1 },
        { displayName: 'A', startedAtMs: t0Ms + 5_000, frames: 2 },
      ],
    );
    // same user, distinct minute/clock → distinct paths (sessionUserFile stamps ms; never change it here)
    assert.notEqual(result.userFiles[0].path, result.userFiles[1].path);
    assert.equal(result.files.length, 2);
  });

  it('two distinct users with identical displayName → two userFiles entries, no dedupe', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 15, 0, 0, 0);
    let tick = 0;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      now: () => new Date(t0Ms + tick++),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();
    recorder.addUser({ id: '111111111111111111', displayName: 'Alex' });
    recorder.addUser({ id: '222222222222222222', displayName: 'Alex' });
    streams.get('111111111111111111').push(fakePacket());
    streams.get('222222222222222222').push(fakePacket());
    recorder.markConfirmed('111111111111111111');
    recorder.markConfirmed('222222222222222222');
    const result = recorder.stop();
    assert.equal(result.userFiles.length, 2);
    assert.deepEqual(result.userFiles.map((e) => e.displayName), ['Alex', 'Alex']);
    assert.notEqual(result.userFiles[0].startedAtMs, result.userFiles[1].startedAtMs);
    assert.notEqual(result.userFiles[0].path, result.userFiles[1].path);
  });

  it('writePerUserFiles=false → userFiles empty, startedAtMs still stamped, master flow untouched', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 16, 0, 0, 0);
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      writePerUserFiles: false,
      now: () => new Date(t0Ms),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    recorder.removeUser('u1');
    const result = recorder.stop();
    assert.deepEqual(result.userFiles, []);
    assert.deepEqual(result.files, []);
    assert.equal(result.startedAtMs, t0Ms);
  });

  it('stop() twice: second call returns empty userFiles/files, same startedAtMs, no crash', () => {
    const t0Ms = Date.UTC(2026, 8, 19, 17, 0, 0, 0);
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      mux: muxOpusToOgg,
      now: () => new Date(t0Ms),
      subscribe: (userId) => {
        const s = fakeSubscribe();
        streams.set(userId, s);
        return s;
      },
    });
    recorder.start();
    recorder.addUser({ id: 'u1', displayName: 'Alice' });
    streams.get('u1').push(fakePacket(30));
    recorder.markConfirmed('u1');
    const first = recorder.stop();
    assert.equal(first.userFiles.length, 1);
    const second = recorder.stop();
    // pinned existing behavior: stop() does not reset accumulators — a
    // second call replays the same result (no re-finalize, no crash, no
    // duplicate pushes since no users remain in the map).
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.userFiles, first.userFiles);
    assert.equal(second.dir, null);
    assert.equal(second.startedAtMs, t0Ms);
  });

  it('keeps only packets the decoder accepted; counts the rest', () => {
    const bad = Buffer.from(
      JSON.parse(readFileSync(new URL('./fixtures/undecodable-opus-packets.json', import.meta.url), 'utf8')).packets[0],
      'base64',
    );
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(Date.UTC(2026, 9, 2, 12, 0, 0)),
      mux: muxOpusToOgg,
      subscribe: (id) => {
        const s = fakeSubscribe();
        streams.set(id, s);
        return s;
      },
      onPacket: (_id, buf) => !buf.equals(bad),
    });
    recorder.start();
    const lines = [];
    const origLog = console.log;
    console.log = (m) => lines.push(String(m));
    let result;
    try {
      recorder.addUser({ id: 'u1', displayName: 'Dee' });
      streams.get('u1').push(bad);
      streams.get('u1').push(fakePacket(30));
      streams.get('u1').push(fakePacket(30));
      recorder.markConfirmed('u1');
      recorder.addUser({ id: 'u2', displayName: 'AllBad' });
      streams.get('u2').push(bad);
      recorder.markConfirmed('u2');
      result = recorder.stop();
    } finally {
      console.log = origLog;
    }
    assert.equal(result.userFiles.length, 1);
    assert.equal(result.userFiles[0].frames, 2);
    assert.equal(result.userFiles[0].dropped, 1);
    assert.ok(lines.some((l) => /Dee recording file created .*\(2 frames\), 1 undecodable packet\(s\) dropped/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /AllBad recording skipped \(no decodable audio — 1 packets dropped\)/.test(l)), lines.join('\n'));
  });

  // --- v3.0.2 D4: the session timeline file --------------------------------

  it('writes a timeline file: session, track, speech bursts, leave/rejoin, end', () => {
    const t0Ms = Date.UTC(2026, 8, 20, 10, 0, 0, 0);
    let clock = t0Ms;
    let calls = 0;
    /** @type {Map<string, PassThrough>} */
    const streams = new Map();
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      now: () => {
        calls += 1;
        return new Date(clock);
      },
      subscribe: (id) => {
        const s = new PassThrough();
        streams.set(id, s);
        return s;
      },
    });
    const info = recorder.start();
    assert.equal(calls, 1, 'start() performs exactly one now() read');
    assert.match(info.timelinePath, /timeline-20260920-100000-000\.jsonl$/);
    assert.equal(info.timelinePath, join(info.dir, 'timeline-20260920-100000-000.jsonl'));

    clock = t0Ms + 5_000;
    recorder.addUser({ id: 'u1', displayName: 'Ann' });
    const s1 = streams.get('u1');
    clock = t0Ms + 6_000;
    s1.emit('data', fakePacket()); // burst 1 (first packet)
    clock = t0Ms + 6_020;
    s1.emit('data', fakePacket()); // same burst
    clock = t0Ms + 7_000;
    s1.emit('data', fakePacket()); // burst 2 (after gap)
    clock = t0Ms + 8_000;
    recorder.removeUser('u1'); // leave
    clock = t0Ms + 9_000;
    recorder.addUser({ id: 'u1', displayName: 'Ann' }); // reconnect
    streams.get('u1').emit('data', fakePacket());
    clock = t0Ms + 10_000;
    const result = recorder.stop();
    assert.equal(result.timelinePath, info.timelinePath);

    const lines = readFileSync(info.timelinePath, 'utf8').split('\n');
    assert.equal(lines.pop(), '', 'file ends with a newline');
    const ev = lines.map((l) => JSON.parse(l));
    assert.deepEqual(
      ev.map((e) => e.type),
      ['session', 'track', 'speech', 'speech', 'leave', 'reconnect', 'track', 'speech', 'leave', 'end'],
    );
    assert.equal(ev[0].t0, info.startedAtMs);
    assert.equal(ev[0].guildId, '123456789012345678');
    assert.equal(ev[1].deltaMs, 5_000);
    assert.equal(ev[1].userId, 'u1');
    assert.match(ev[1].file, /^Ann-.*\.ogg$/);
    assert.equal(ev[2].t, t0Ms + 6_000);
    // The track starts at addUser (t0+5s): 980 ms of leading silence = 49 frames.
    assert.equal(ev[2].trackMs, 49 * 20);
    assert.equal(ev[3].t, t0Ms + 7_000);
    // 49 lead-in + 2 packets + 48 silence frames padding the 980 ms gap.
    assert.equal(ev[3].trackMs, (49 + 2 + 48) * 20);
    assert.equal(ev[4].t, t0Ms + 8_000);
    assert.equal(ev[7].trackMs, 0, 'a new track restarts its position');
    assert.equal(ev.at(-1).durationMs, 10_000);
    assert.equal(ev.at(-1).t0, t0Ms);
  });

  it('timeline is not written when writePerUserFiles=false; start() timelinePath is null', () => {
    const t0Ms = Date.UTC(2026, 8, 20, 11, 0, 0, 0);
    const recorder = new Recorder({
      meetingsRoot: root,
      botUserId: 'bot1',
      guildId: '123456789012345678',
      startedAt: new Date(t0Ms),
      now: () => new Date(t0Ms),
      writePerUserFiles: false,
      subscribe: () => fakeSubscribe(),
    });
    const info = recorder.start();
    assert.equal(info.timelinePath, null);
    recorder.addUser({ id: 'u1', displayName: 'A' });
    assert.equal(recorder.stop().timelinePath, null);
    assert.equal(readdirSync(info.dir).filter((f) => f.startsWith('timeline-')).length, 0);
  });

  it('a timeline write failure logs once and never throws into the data callback', () => {
    const t0Ms = Date.UTC(2026, 8, 20, 12, 0, 0, 0);
    let clock = t0Ms;
    const streams = new Map();
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const recorder = new Recorder({
        meetingsRoot: root,
        botUserId: 'bot1',
        guildId: '123456789012345678',
        startedAt: new Date(t0Ms),
        now: () => new Date(clock),
        subscribe: (id) => {
          const s = new PassThrough();
          streams.set(id, s);
          return s;
        },
      });
      const info = recorder.start();
      // Replace the timeline file with a directory so every append fails.
      rmSync(info.timelinePath, { force: true });
      mkdirSync(info.timelinePath);
      recorder.addUser({ id: 'u1', displayName: 'A' });
      clock = t0Ms + 1_000;
      streams.get('u1').emit('data', fakePacket());
      clock = t0Ms + 3_000;
      streams.get('u1').emit('data', fakePacket());
      const result = recorder.stop();
      assert.equal(result.userFiles.length, 1, 'the track is still written');
    } finally {
      console.log = orig;
    }
    const failed = lines.filter((l) => /timeline write failed for /.test(l));
    assert.equal(failed.length, 1, lines.join('\n'));
  });
  it('a failing stream is logged, keeps its audio, and re-subscribes on the next addUser', () => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const t0Ms = Date.UTC(2026, 8, 18, 21, 4, 33);
      let clock = t0Ms;
      const streams = [];
      const recorder = new Recorder({
        meetingsRoot: root,
        botUserId: 'bot1',
        guildId: '223456789012345678',
        startedAt: new Date(t0Ms),
        now: () => new Date(clock),
        subscribe: () => {
          const s = new PassThrough();
          streams.push(s);
          return s;
        },
      });
      recorder.start();
      recorder.addUser({ id: 'u1', displayName: 'Alice' });
      streams[0].emit('data', fakePacket());
      streams[0].emit('data', fakePacket());
      assert.doesNotThrow(() => streams[0].emit('error', new Error('decrypt boom')));
      assert.doesNotThrow(() => streams[0].emit('close'));
      const ended = lines.filter((l) => /Alice's audio stream ended/.test(l));
      assert.equal(ended.length, 1, lines.join('\n'));
      assert.equal(recorder.users.get('u1').dead, true);

      clock = t0Ms + 5_000;
      recorder.addUser({ id: 'u1', displayName: 'Alice' });
      assert.equal(streams.length, 2, 'a dead entry re-subscribes');
      clock = t0Ms + 6_000;
      streams[1].emit('data', fakePacket());
      const result = recorder.stop();
      assert.equal(result.userFiles.length, 2, 'pre-failure audio is written, plus a new file');
      assert.notEqual(result.userFiles[0].path, result.userFiles[1].path);
      assert.equal(result.userFiles[0].speechFrames, 2);
      assert.equal(result.userFiles[1].speechFrames, 1);
      const kinds = readFileSync(result.timelinePath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => ['leave', 'reconnect', 'track'].includes(e.type ?? e.kind ?? e.event))
        .map((e) => e.type ?? e.kind ?? e.event);
      assert.deepEqual(kinds.slice(0, 4), ['track', 'leave', 'reconnect', 'track']);
    } finally {
      console.log = orig;
    }
  });
});
