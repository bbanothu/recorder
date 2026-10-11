import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
    rmSync,
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    statSync,
    truncateSync,
  } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import OpusScript from 'opusscript';
import {
  MasterMix,
  softLimitToInt16,
  FRAME_MS,
  FRAME_SAMPLES,
  CHANNELS,
  DEFAULT_MASTER_BITRATE,
  buildFfmpegArgs,
} from '../src/master-mix.js';
import { writeWavFile } from '../src/wav.js';

/** Frozen WAV bytes produced by the PRE-Task-3b in-RAM implementation. */
const GOLDEN_WAV = new URL('./fixtures/master-mix-golden.wav', import.meta.url);

/** Deterministic per-user PCM frame (no opusscript) for the golden fixture. */
function goldenPcm(seed) {
  const a = new Int16Array(1920);
  for (let i = 0; i < 1920; i++) a[i] = ((i * 37 + seed * 101) % 60001) - 30000;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * The golden fixture sequence: u1@0 and u2@0 overlap on frame 0, u1@100ms
 * lands on frame 5 (frames 1-4 mostly silent), u2@40ms lands on frame 2.
 */
function goldenMix(tmpDir) {
  let seed = 0;
  const mix = new MasterMix({
    now: () => 0,
    tmpDir,
    createDecoder: () => ({ decode: () => goldenPcm(seed++) }),
    encodeToOgg: () => {
      throw new Error('no ffmpeg in the golden fixture');
    },
  });
  mix.start(0);
  mix.push('u1', Buffer.from([1]), 0);
  mix.push('u2', Buffer.from([1]), 0);
  mix.push('u1', Buffer.from([1]), 100);
  mix.push('u2', Buffer.from([1]), 40);
  return mix;
}

/** @param {string} dir */
function mixTemps(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.mix.tmp'));
}

function encodeSilence() {
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  return Buffer.from(enc.encode(Buffer.alloc(960 * 2 * 2), 960));
}

/** Raw PCM frame (as a decoder seam would return): 1920 interleaved int16 samples. */
function pcmFrame(n = 1920) {
  const a = new Int16Array(n).fill(1000);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** Capture console.log while fn runs; returns the collected lines. */
async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('softLimitToInt16', () => {
  it('stays within int16 and soft-saturates', () => {
    assert.equal(softLimitToInt16(0), 0);
    assert.ok(Math.abs(softLimitToInt16(0.1)) < 4000);
    assert.ok(softLimitToInt16(5) < 32768);
    assert.ok(softLimitToInt16(5) > 30000);
  });
});

describe('writeWavFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-wav-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a valid RIFF header', () => {
    const path = join(root, 't.wav');
    writeWavFile(path, new Int16Array([0, 0, 1000, -1000]), {
      sampleRate: 48000,
      channels: 2,
    });
    const buf = readFileSync(path);
    assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buf.subarray(8, 12).toString(), 'WAVE');
  });
});

describe('MasterMix', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-master-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finalize with no packets returns null', async () => {
    const mix = new MasterMix();
    mix.start(0);
    assert.equal(await mix.finalize(root), null);
  });

  it('snaps to 20ms grid and encodes via ffmpeg (or wav fallback)', async () => {
    let t = 0;
    const mix = new MasterMix({
      now: () => t,
      tmpDir: root,
    });
    mix.start(0);

    const pkt = encodeSilence();
    t = 0;
    mix.push('u1', pkt);
    t = 7; // should snap near frame 0; monotonic bumps to frame 1
    mix.push('u1', pkt);
    t = 40;
    mix.push('u2', pkt);

    assert.equal(FRAME_MS, 20);

    const path = await mix.finalize(root, new Date('2026-09-18T21:00:00.000Z'));
    assert.ok(path);
    assert.ok(existsSync(path));
    const name = path.replace(/\\/g, '/');
    assert.match(name, /master-20260918-210000-000\.(ogg|wav)$/);
    if (name.endsWith('.ogg')) {
      assert.equal(readFileSync(path).subarray(0, 4).toString(), 'OggS');
    } else {
      assert.equal(readFileSync(path).subarray(0, 4).toString(), 'RIFF');
    }
  });

  it('soft-limits overlapping loud PCM', async () => {
    const loud = new Int16Array(1920).fill(30000);
    const pcmBuf = Buffer.from(loud.buffer, loud.byteOffset, loud.byteLength);
    const mix = new MasterMix({
      now: () => 0,
      tmpDir: root,
      createDecoder: () => ({
        decode: () => pcmBuf,
      }),
      encodeToOgg: (wav, ogg) => {
        // pretend ffmpeg: copy wav bytes is wrong for ogg — write empty ogg-like via failing
        // Force wav fallback by throwing
        throw new Error('skip ffmpeg in unit test');
      },
    });
    mix.start(0);
    mix.push('a', Buffer.from([1]));
    mix.push('b', Buffer.from([1]));
    const path = await mix.finalize(root, new Date('2026-09-18T21:01:00.000Z'));
    assert.ok(path.endsWith('.wav'));
    assert.ok(existsSync(path));
  });

  // --- failure isolation (v3.0.0: finalize() now runs for EVERY session) ---

  it('finalize() is total: an unwritable path logs loudly, resets, returns null (no throw)', async () => {
    // Parent that is a FILE → sessionMasterFile() under it is un-writable and
    // the WAV writer's write fails (ENOTDIR). finalize() must absorb it.
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const mix = new MasterMix({
      now: () => 0,
      tmpDir: root,
      createDecoder: () => ({ decode: () => pcmFrame() }),
    });
    mix.start(0);
    mix.push('a', Buffer.from([1]));
    assert.equal(mix.packetCount, 1);

    let path;
    const logs = await captureLogs(async () => {
      path = await mix.finalize(blocker, new Date('2026-09-18T21:02:00.000Z'));
    });
    assert.equal(path, null, 'no path returned when the write fails');
    assert.equal(mixTemps(root).length, 0, 'temp unlinked after the failed finalize');
    const loud = logs.filter((l) => /master mix/i.test(l) && /not-a-dir/.test(l));
    assert.equal(loud.length, 1, `logged loudly w/ the intended path: ${logs.join(' | ')}`);
    // #reset() ran: a second finalize is a clean no-audio skip, not a re-throw.
    assert.equal(mix.packetCount, 0);
    assert.equal(await mix.finalize(root), null);
  });

  it('finalize() is total when dir is null (no session dir) — returns null, never throws', async () => {
    const mix = new MasterMix({
      now: () => 0,
      tmpDir: root,
      createDecoder: () => ({ decode: () => pcmFrame() }),
    });
    mix.start(0);
    mix.push('a', Buffer.from([1]));

    let path;
    const logs = await captureLogs(async () => {
      path = await mix.finalize(null, new Date('2026-09-18T21:03:00.000Z'));
    });
    assert.equal(path, null);
    assert.equal(mixTemps(root).length, 0, 'temp unlinked after the null-dir bail-out');
    assert.ok(logs.some((l) => /master mix/i.test(l)), `logged the failure: ${logs.join(' | ')}`);
    assert.equal(mix.packetCount, 0, 'reset after the failure');
  });

  // --- Task 3b / AC12: sparse temp-file accumulator -------------------------

  it('GOLDEN: output WAV bytes are byte-identical to the pre-3b in-RAM implementation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-golden-out-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-golden-tmp-'));
    try {
      const mix = goldenMix(tmpDir);
      const path = await mix.finalize(dir, new Date('2026-09-18T21:00:00.000Z'));
      assert.equal(path, join(dir, 'master-20260918-210000-000.wav'));
      const bytes = readFileSync(path);
      const golden = readFileSync(GOLDEN_WAV);
      assert.equal(bytes.length, golden.length, 'same byte length as the frozen golden');
      assert.ok(bytes.equals(golden), 'byte-identical to the frozen in-RAM golden WAV');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bounds memory: a 30+ minute session allocates no session-length buffer', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-bound-tmp-'));
    try {
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: () => {
          throw new Error('no ffmpeg');
        },
      });
      mix.start(0);
      const before = process.memoryUsage();

      // 62 packets, one every 30 s -> a >30 minute span, all but 62 frames silent.
      const packets = 62;
      for (let i = 0; i < packets; i++) mix.push('u1', Buffer.from([1]), i * 30_000);
      const after = process.memoryUsage();

      // The pre-3b accumulator was a Float32Array sized to the SESSION SPAN:
      // ~0.7 GB of ArrayBuffer backing store for this span. Backing stores are
      // counted in `external`, NOT in `heapUsed` (a 180 MB Float32Array moves
      // heapUsed by ~0 MB), so only these numbers can tell the streamed
      // accumulator from the in-RAM one.
      const externalGrowth = after.external - before.external;
      assert.ok(
        externalGrowth < 64 * 1024 * 1024,
        `resident ArrayBuffer growth stays bounded for a 30+ min span (${externalGrowth} bytes; 64 MB budget)`,
      );
      const rssGrowth = after.rss - before.rss;
      assert.ok(
        rssGrowth < 512 * 1024 * 1024,
        `rss growth stays bounded for a 30+ min span (${rssGrowth} bytes)`,
      );

      const temps = mixTemps(tmpDir);
      assert.equal(temps.length, 1, 'exactly one temp file');
      const tmpPath = join(tmpDir, temps[0]);
      // Highest written offset in interleaved-float32 bytes: the session spans
      // >30 min of wall time but only these 62 frames carry audio.
      const lastFrame = ((packets - 1) * 30_000) / FRAME_MS;
      const highestBytes = (lastFrame * FRAME_SAMPLES * CHANNELS + FRAME_SAMPLES * CHANNELS) * 4;
      assert.equal(
        statSync(tmpPath).size,
        highestBytes,
        'temp size tracks the highest written offset (float32 stereo), not elapsed time',
      );
      assert.equal(statSync(tmpPath).size, mix.used * 4, 'temp size == highest offset in bytes');

      // Field-independent: resident cost must be O(packet), not O(offset). One
      // further packet at an even higher offset may only cost a packet's worth
      // of storage.
      const beforeFar = process.memoryUsage().external;
      mix.push('u2', Buffer.from([1]), (packets + 1) * 30_000);
      const farGrowth = process.memoryUsage().external - beforeFar;
      assert.ok(
        farGrowth < 4 * 1024 * 1024,
        `a far-offset packet allocates O(packet), not O(offset) (${farGrowth} bytes)`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('unspoken time is a sparse hole: a positional write past EOF reads back as zeros', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-hole-tmp-'));
    try {
      const pcm = pcmFrame(); // a frame of 1000s → non-zero bytes
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcm }),
        encodeToOgg: () => {
          throw new Error('no ffmpeg');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 60); // frame 3 → frames 0-2 are a hole

      const temps = mixTemps(tmpDir);
      assert.equal(temps.length, 1);
      const raw = readFileSync(join(tmpDir, temps[0]));
      assert.equal(raw.length, mix.used * 4);
      const frameBytes = FRAME_SAMPLES * CHANNELS * 4;
      assert.ok(
        raw.subarray(0, 3 * frameBytes).every((b) => b === 0),
        'the unspoken hole reads back as zeros',
      );
      assert.ok(raw.subarray(3 * frameBytes).some((b) => b !== 0), 'the written frame is present');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a failed conversion leaves NO corrupt WAV behind (only the temp is cleaned up)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-corrupt-dir-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-corrupt-tmp-'));
    try {
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: () => {
          throw new Error('must not run: the WAV stream itself failed');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 0);
      assert.ok(mix.mixPath, 'the mix temp exists after a push');
      // Truncate the temp behind the accumulator's back: the streaming WAV pass
      // hits EOF long before the recorded highest offset and fails mid-stream,
      // leaving a half-written WAV (header patched to dataSize=0).
      truncateSync(mix.mixPath, 4096);

      let path = 'unset';
      const logs = await captureLogs(async () => {
        path = await mix.finalize(dir, new Date('2026-09-18T21:05:00.000Z'));
      });

      assert.equal(path, null, 'the mid-stream failure is reported as null (no file claimed)');
      assert.equal(mixTemps(tmpDir).length, 0, 'the mix temp is unlinked');
      const wavLeftovers = readdirSync(dir).filter((f) => /^master-.*\.wav$/i.test(f));
      assert.deepEqual(
        wavLeftovers,
        [],
        `no corrupt WAV accumulates in the session dir: ${wavLeftovers.join(', ')}`,
      );
      assert.equal(readdirSync(dir).length, 0, 'the session dir is empty after the failure');
      assert.ok(
        logs.some((l) => /master mix FAILED/.test(l)),
        `logged loudly: ${logs.join(' | ')}`,
      );
      assert.equal(mix.packetCount, 0, 'reset after the failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a push-time IO failure never escapes the caller: ioError only, later finalize returns null', async () => {
    const root2 = mkdtempSync(join(tmpdir(), 'dmr-pushio-'));
    try {
      // The temp's parent is a FILE, so the first positional write's open fails.
      const blocker = join(root2, 'blocked-dir');
      writeFileSync(blocker, 'x');
      const mix = new MasterMix({
        now: () => 0,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: () => {
          throw new Error('no ffmpeg');
        },
      });
      mix.start(0, blocker);

      const logs = await captureLogs(async () => {
        assert.doesNotThrow(
          () => mix.push('u1', Buffer.from([1]), 0),
          'a disk failure must not propagate into the voice-data callback',
        );
      });

      assert.ok(mix.ioError, 'the accumulation failure is recorded');
      assert.equal(mix.packetCount, 0, 'the failed packet is not counted');
      assert.equal(mix.used, 0, 'no samples are marked written');
      assert.equal(mix.fd, null, 'no fd is retained after the failed open');
      assert.ok(
        logs.some((l) => /master mix FAILED/.test(l)),
        `logged the io failure: ${logs.join(' | ')}`,
      );

      // A later push stays a no-op (ioError latches) and never throws.
      assert.doesNotThrow(() => mix.push('u1', Buffer.from([1]), 1000));
      assert.equal(mix.packetCount, 0);

      let path = 'unset';
      const finLogs = await captureLogs(async () => {
        path = await mix.finalize(join(root2, 'session'), new Date('2026-09-18T21:04:00.000Z'));
      });
      assert.equal(path, null, 'finalize gives up on the master only');
      assert.equal(mixTemps(root2).length, 0, 'no temp is left behind');
      assert.ok(finLogs.some((l) => /master mix FAILED/.test(l)), 'finalize logs the latched failure');
      assert.equal(mix.ioError, null, 'reset clears the latched failure');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it('a failed post-encode unlink keeps the .ogg, warns, and does not blame ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-unlink-dir-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-unlink-tmp-'));
    try {
      let unlinkCalls = 0;
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: (wav, ogg) => {
          assert.ok(existsSync(wav), 'the WAV exists when the encoder runs');
          writeFileSync(ogg, 'OggS');
        },
        // An AV scanner holding the WAV (Windows): the unlink throws although
        // the encode produced a perfectly good .ogg.
        unlinkFile: () => {
          unlinkCalls += 1;
          throw new Error('EBUSY: the file is held by another process');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 0);

      let path = 'unset';
      const logs = await captureLogs(async () => {
        path = await mix.finalize(dir, new Date('2026-09-18T21:06:00.000Z'));
      });

      assert.equal(
        path,
        join(dir, 'master-20260918-210600-000.ogg'),
        'the produced .ogg is still the delivered artifact',
      );
      assert.equal(unlinkCalls, 1, 'the WAV unlink was attempted');
      assert.ok(existsSync(path), 'the .ogg is on disk');
      assert.ok(
        !logs.some((l) => /ffmpeg opus failed/i.test(l)),
        `no bogus ffmpeg failure is reported: ${logs.join(' | ')}`,
      );
      assert.ok(
        logs.some((l) => /could not be removed|EBUSY/i.test(l)),
        `the failed unlink is warned about: ${logs.join(' | ')}`,
      );
      assert.equal(mixTemps(tmpDir).length, 0, 'temp gone after success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('unlinks the temp file BEFORE the encode runs, and after success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-hygiene-dir-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-hygiene-tmp-'));
    try {
      /** @type {string[] | null} */
      let tempsAtEncode = null;
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: (wav, ogg) => {
          tempsAtEncode = mixTemps(tmpDir);
          assert.ok(existsSync(wav), 'the WAV exists when ffmpeg runs');
          writeFileSync(ogg, 'OggS');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 0);
      const path = await mix.finalize(dir, new Date('2026-09-18T21:00:00.000Z'));

      assert.equal(path, join(dir, 'master-20260918-210000-000.ogg'));
      assert.deepEqual(tempsAtEncode, [], 'temp is gone before ffmpeg starts');
      assert.equal(mixTemps(tmpDir).length, 0, 'temp gone after success');
      assert.ok(
        !existsSync(join(dir, 'master-20260918-210000-000.wav')),
        'wav unlinked after the encode',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('drops the temp even on the ffmpeg-failure (WAV fallback) path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-fallback-dir-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-fallback-tmp-'));
    try {
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({ decode: () => pcmFrame() }),
        encodeToOgg: () => {
          throw new Error('ffmpeg unavailable');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 0);
      const path = await mix.finalize(dir, new Date('2026-09-18T21:00:00.000Z'));

      assert.ok(path.endsWith('.wav'), 'ffmpeg failure keeps the WAV');
      assert.ok(existsSync(path));
      assert.equal(mixTemps(tmpDir).length, 0, 'temp gone even on the ffmpeg-failure path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('frees every decoder on reset (one delete per user)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-dec-dir-'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'dmr-dec-tmp-'));
    try {
      let deletes = 0;
      const mix = new MasterMix({
        now: () => 0,
        tmpDir,
        createDecoder: () => ({
          decode: () => pcmFrame(),
          delete() {
            deletes += 1;
          },
        }),
        encodeToOgg: () => {
          throw new Error('no ffmpeg');
        },
      });
      mix.start(0);
      mix.push('u1', Buffer.from([1]), 0);
      mix.push('u2', Buffer.from([1]), 0);
      assert.equal(deletes, 0, 'decoders live while the session runs');

      await mix.finalize(dir, new Date('2026-09-18T21:00:00.000Z'));
      assert.equal(deletes, 2, 'one decoder.delete() per user');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('frees the previous session decoders on start()', () => {
    let deletes = 0;
    const mix = new MasterMix({
      now: () => 0,
      createDecoder: () => ({
        decode: () => pcmFrame(),
        delete() {
          deletes += 1;
        },
      }),
    });
    mix.start(0);
    mix.push('u1', Buffer.from([1]), 0);
    mix.start(1_000);
    assert.equal(deletes, 1, 'start() releases the previous session decoders');
  });
});

describe('buildFfmpegArgs', () => {
  it('defaults: 24k mono voip', () => {
    assert.equal(DEFAULT_MASTER_BITRATE, '24k');
    const args = buildFfmpegArgs('in.wav', 'out.ogg');
    assert.ok(args.includes('-b:a'));
    assert.equal(args[args.indexOf('-b:a') + 1], '24k');
    assert.equal(args[args.indexOf('-ac') + 1], '1');
    assert.equal(args[args.indexOf('-application') + 1], 'voip');
    assert.equal(args.at(-1), 'out.ogg');
  });

  it('honors explicit bitrate', () => {
    const args = buildFfmpegArgs('in.wav', 'out.ogg', '32k');
    assert.equal(args[args.indexOf('-b:a') + 1], '32k');
  });
});

describe('MasterMix#push verdict (v3.0.2 D2)', () => {
  const okDecoder = () => ({ decode: () => pcmFrame() });
  const badDecoder = () => ({
    decode: () => {
      throw new Error('Decode error: Invalid packet');
    },
  });
  const mk = (createDecoder, tmpDir) =>
    new MasterMix({ now: () => 0, tmpDir, createDecoder, encodeToOgg: () => {} });
  const dir = mkdtempSync(join(tmpdir(), 'dmr-verdict-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('false for a decoder-rejected packet', () => {
    const mix = mk(badDecoder, dir);
    mix.start(0, dir);
    assert.equal(mix.push('u1', Buffer.from([1]), 0), false);
  });
  it('false for a packet that decodes to nothing', () => {
    const mix = mk(() => ({ decode: () => Buffer.alloc(0) }), dir);
    mix.start(0, dir);
    assert.equal(mix.push('u1', Buffer.from([1]), 0), false);
  });
  it('false for an empty packet', () => {
    const mix = mk(okDecoder, dir);
    mix.start(0, dir);
    assert.equal(mix.push('u1', Buffer.alloc(0), 0), false);
  });
  it('true for a valid packet', () => {
    const mix = mk(okDecoder, dir);
    mix.start(0, dir);
    assert.equal(mix.push('u1', Buffer.from([1]), 0), true);
  });
  it('true when the mix was never started (t0 == null): a master failure never strips a track', () => {
    const mix = mk(badDecoder, dir);
    assert.equal(mix.push('u1', Buffer.from([1]), 0), true);
  });
  it('true with ioError set, even for a packet the decoder would reject', () => {
    const mix = mk(badDecoder, dir);
    mix.start(0, dir);
    mix.ioError = new Error('disk full');
    assert.equal(mix.push('u1', Buffer.from([1]), 0), true);
  });
});
