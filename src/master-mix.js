import { unlinkSync, existsSync, openSync, closeSync, readSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import OpusScript from 'opusscript';
import { sessionMasterFile, fileTimestamp } from './session.js';
import { openStreamingWavWriter } from './wav.js';
import { logEvent } from './log.js';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz per channel

/** Opus mono downmix target for the master file (stereo speech wastes ~half the bits). */
export const MASTER_CHANNELS = 1;
/** libopus `-application` mode tuned for speech. */
export const MASTER_APPLICATION = 'voip';
/** Default master bitrate; override with env MASTER_BITRATE. */
export const DEFAULT_MASTER_BITRATE = '24k';

/** Bytes per stored mix sample (interleaved float32 on disk). */
const MIX_BYTES_PER_SAMPLE = 4;
/** Samples per streaming WAV chunk (256 KB of float32 read at a time). */
const WAV_CHUNK_SAMPLES = 1 << 16;

/**
 * Soft limiter toward ±1.0 (float), then quantize to int16.
 * @param {number} sample float
 */
export function softLimitToInt16(sample) {
  const x = Math.tanh(sample);
  return (x * 32767) | 0;
}

/**
 * Session-wide mix: decode Opus → float mix on a 20ms grid → WAV → ffmpeg Opus.
 * Avoids a second opusscript encode pass (main quality killer).
 *
 * v3.0.0 (Task 3b): the mix does NOT live in RAM. It accumulates in
 * `<sessionDir>/master-<stamp>.mix.tmp` as interleaved float32 stereo at the
 * absolute session offset (positional read-modify-write), so unspoken time
 * costs no MEMORY: a read past EOF returns zeros, so the audio is correct and
 * memory stays O(packet) however long the session runs. It is not free on
 * disk, though — NTFS extends the temp to its full length when it backs a
 * far-offset write, so the temp's on-disk size tracks elapsed wall time, not
 * speech. finalize() streams that temp file through softLimitToInt16 into the
 * `.wav`, unlinks the temp BEFORE the ffmpeg pass (temp and WAV are never both
 * resident for the encode) and always removes it, whatever the exit path.
 */
export class MasterMix {
  /**
   * @param {{
   *   createDecoder?: () => { decode: (packet: Buffer) => Buffer, delete?: () => void },
   *   now?: () => number,
   *   encodeToOgg?: (wavPath: string, oggPath: string, bitrate?: string) => void,
   *   bitrate?: string,
   *   tmpDir?: string,
   *   unlinkFile?: (path: string) => void,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.createDecoder =
      opts.createDecoder ??
      (() => new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO));
    this.now = opts.now ?? Date.now;
    this.encodeToOgg = opts.encodeToOgg ?? ffmpegWavToOgg;
    this.bitrate = opts.bitrate ?? DEFAULT_MASTER_BITRATE;
    /** Default directory for the mix temp file (a test seam); start() may override it. */
    this.defaultTmpDir = opts.tmpDir ?? null;
    /** Unlink seam for the post-encode WAV cleanup (default: fs.unlinkSync). */
    this.unlinkFile = opts.unlinkFile ?? unlinkSync;
    /** @type {string | null} Directory the temp file is created in. */
    this.tempDir = this.defaultTmpDir;
    /** @type {number | null} */
    this.t0 = null;
    /**
     * Per-packet scratch for the positional read-modify-write. Bounded by the
     * largest packet (a 20 ms stereo frame = 1920 samples) — NEVER a
     * session-length buffer.
     * @type {Float32Array}
     */
    this.mix = new Float32Array(FRAME_SAMPLES * CHANNELS);
    /** @type {number} interleaved float samples written so far */
    this.used = 0;
    /** @type {number | null} open fd of the mix temp file */
    this.fd = null;
    /** @type {string | null} path of the mix temp file */
    this.mixPath = null;
    /** @type {Error | null} first accumulation failure (the master is then abandoned) */
    this.ioError = null;
    /** @type {Map<string, { decoder: { decode: (packet: Buffer) => Buffer, delete?: () => void }, lastFrame: number }>} */
    this.users = new Map();
    /**
     * Packets accepted into the mix — the mix "heard audio" signal. The bot's
     * stop path reads it BEFORE `finalize()` (which `#reset()`s it) to tell a
     * genuinely silent session from one whose master write failed; renaming
     * this would silently misclassify a failure as silence.
     * @type {number}
     */
    this.packetCount = 0;
  }

  /**
   * @param {number} [atMs] session zero (ms)
   * @param {string} [dir] session directory the temp file lives in
   */
  start(atMs = this.now(), dir = undefined) {
    this.#reset();
    this.t0 = atMs;
    this.tempDir = typeof dir === 'string' && dir ? dir : this.defaultTmpDir;
    logEvent('master mix started (20ms grid → wav/ffmpeg)');
  }

  /**
   * @param {string} userId
   * @param {Buffer} packet
   * @param {number} [atMs]
   * @returns {boolean} false only when the packet is not decodable audio
   */
  push(userId, packet, atMs = this.now()) {
    // Verdict (v3.0.2 D2): `false` ONLY when this session's decoder rejected
    // the packet (or it is empty / decodes to nothing). Every other exit —
    // not started, ioError, success — is `true`, so a master failure never
    // strips audio from a per-user track.
    if (this.t0 == null) return true;
    if (!packet?.length) return false;
    if (this.ioError) return true;

    let state = this.users.get(userId);
    if (!state) {
      state = {
        decoder: this.createDecoder(),
        lastFrame: -1,
      };
      this.users.set(userId, state);
    }

    let pcmBuf;
    try {
      pcmBuf = state.decoder.decode(packet);
    } catch {
      return false;
    }
    if (!pcmBuf?.length) return false;

    const pcm = new Int16Array(
      pcmBuf.buffer,
      pcmBuf.byteOffset,
      Math.floor(pcmBuf.byteLength / 2),
    );

    const elapsedMs = Math.max(0, atMs - this.t0);
    // Snap to 20ms grid; keep per-user frames monotonic to avoid self-overlap from jitter
    let frameIndex = Math.round(elapsedMs / FRAME_MS);
    if (frameIndex <= state.lastFrame) {
      frameIndex = state.lastFrame + 1;
    }
    state.lastFrame = frameIndex;

    const offset = frameIndex * FRAME_SAMPLES * CHANNELS;
    try {
      this.#addAt(offset, pcm);
    } catch (err) {
      // Never escape into the voice-data callback (bot.js's onPacket): a disk
      // failure must not abort the session. Give up on the master only.
      this.ioError = err;
      logEvent(
        `master mix FAILED (${err?.message ?? err}); cannot accumulate at offset ${offset} in ${this.mixPath ?? this.tempDir ?? tmpdir()}`,
      );
      return true;
    }
    this.packetCount += 1;
    return true;
  }

  /**
   * @param {string} dir
   * @param {Date} [at]
   * @returns {Promise<string | null>}
   */
  async finalize(dir, at = new Date()) {
    if (this.ioError) {
      logEvent(
        `master mix FAILED (${this.ioError?.message ?? this.ioError}); no master file (${this.packetCount} packets, ${this.used} samples)`,
      );
      this.#reset();
      return null;
    }

    if (this.t0 == null || this.packetCount === 0 || this.used === 0) {
      logEvent('master mix skipped (no audio)');
      this.#reset();
      return null;
    }

    // sessionMasterFile() itself throws for an ill-shaped dir (e.g. null):
    // no path is derivable then, so finalize() gives up on the master only.
    let basePath = null;
    try {
      basePath = sessionMasterFile(dir, at);
    } catch {
      basePath = null;
    }

    let wavPath;
    try {
      if (!basePath) throw new Error(`no session directory (dir=${String(dir)})`);
      wavPath = basePath.replace(/\.ogg$/i, '.wav');
      this.#writeWav(wavPath);
    } catch (err) {
      // Total by construction (v3.0.0): every session now builds a master, so
      // a disk-full/EPERM/ENOSPC (or a missing session dir) must never reject
      // into stopSession(). Log loudly and give up on the master only.
      logEvent(
        `master mix FAILED (${err?.message ?? err}); no master file at ${basePath ?? String(dir)} (${this.packetCount} packets, ${this.used} samples)`,
      );
      this.#reset();
      return null;
    } finally {
      // (b) The temp dies as soon as the WAV exists — temp and WAV are never
      // both resident for the length of the encode. Covers every failure
      // above too (the null-dir bail-out included).
      this.#unlinkTemp();
    }

    const oggPath = basePath;
    try {
      this.encodeToOgg(wavPath, oggPath, this.bitrate);
    } catch (err) {
      logEvent(
        `master ffmpeg opus failed (${err?.message ?? err}); keeping WAV → ${basename(wavPath)}`,
      );
      this.#reset();
      return wavPath;
    }

    // The encode succeeded, so the WAV is disposable — but a failed unlink
    // (e.g. a Windows AV scanner holding the file) is NOT an encode failure:
    // warn about the leftover WAV and still deliver the `.ogg` we produced.
    try {
      if (existsSync(wavPath)) this.unlinkFile(wavPath);
    } catch (err) {
      logEvent(
        `master wav could not be removed (${err?.message ?? err}); delete ${basename(wavPath)} manually`,
      );
    }
    logEvent(
      `master recording file created → ${basename(oggPath)} (${this.packetCount} packets, grid=${FRAME_MS}ms, ffmpeg opus ${this.bitrate} mono voip)`,
    );
    this.#reset();
    return oggPath;
  }

  /** Drop the session: close + unlink the temp, free the decoders, clear state. */
  #reset() {
    this.#unlinkTemp();
    for (const state of this.users.values()) {
      try {
        state.decoder?.delete?.();
      } catch {
        // The decoder was already released (or the seam has no delete()).
      }
      state.decoder = null;
    }
    this.users.clear();
    this.t0 = null;
    this.used = 0;
    this.ioError = null;
    this.packetCount = 0;
  }

  /** Close the temp fd (if open) and unlink the temp file. Idempotent, never throws. */
  #unlinkTemp() {
    if (this.fd != null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
    const path = this.mixPath;
    this.mixPath = null;
    if (path && existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        logEvent(
          `master mix temp could not be removed (${err?.message ?? err}); delete ${path} manually`,
        );
      }
    }
  }

  /** Open (once) the sparse mix temp file and return its fd. */
  #ensureTemp() {
    if (this.fd != null) return this.fd;
    const parent = this.tempDir ?? tmpdir();
    const path = join(parent, `master-${fileTimestamp(new Date(this.t0 ?? this.now()))}.mix.tmp`);
    const fd = openSync(path, 'w+');
    this.fd = fd;
    this.mixPath = path;
    return fd;
  }

  /**
   * Positional read-modify-write at an absolute interleaved sample offset.
   * A read past EOF yields zeros, so unspoken time stays a hole and the file
   * grows only to the highest written offset.
   * @param {number} offset interleaved float samples
   * @param {Int16Array} pcm int16 source
   */
  #addAt(offset, pcm) {
    const fd = this.#ensureTemp();
    const byteOffset = offset * MIX_BYTES_PER_SAMPLE;
    const byteLength = pcm.length * MIX_BYTES_PER_SAMPLE;

    if (this.mix.length < pcm.length) this.mix = new Float32Array(pcm.length);
    const scratch = this.mix;
    const bytes = new Uint8Array(scratch.buffer, 0, byteLength);
    bytes.fill(0);

    let read = 0;
    while (read < byteLength) {
      const n = readSync(fd, bytes, read, byteLength - read, byteOffset + read);
      if (n <= 0) break;
      read += n;
    }

    // Bit-identical to the old in-RAM `mix[offset + i] += pcm[i] / 32768`:
    // the stored float32 value is read back, summed in double, re-rounded.
    for (let i = 0; i < pcm.length; i++) {
      scratch[i] = scratch[i] + pcm[i] / 32768;
    }
    writeSync(fd, bytes, 0, byteLength, byteOffset);
    this.used = Math.max(this.used, offset + pcm.length);
  }

  /** Stream the sparse temp file into a WAV, bounded chunks, nothing resident. */
  #writeWav(wavPath) {
    const fd = this.fd;
    if (fd == null) throw new Error('no mix temp file to convert');

    const writer = openStreamingWavWriter(wavPath, {
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    try {
      const floats = new Float32Array(WAV_CHUNK_SAMPLES);
      const inBytes = new Uint8Array(floats.buffer, 0, WAV_CHUNK_SAMPLES * MIX_BYTES_PER_SAMPLE);
      const out = new Int16Array(WAV_CHUNK_SAMPLES);
      const totalBytes = this.used * MIX_BYTES_PER_SAMPLE;

      let pos = 0;
      while (pos < totalBytes) {
        const want = Math.min(inBytes.length, totalBytes - pos);
        let got = 0;
        while (got < want) {
          const n = readSync(fd, inBytes, got, want - got, pos + got);
          if (n <= 0) break;
          got += n;
        }
        if (got !== want) {
          throw new Error(`mix temp file ended early at byte ${pos + got} of ${totalBytes}`);
        }
        const n = want / MIX_BYTES_PER_SAMPLE;
        for (let i = 0; i < n; i++) {
          out[i] = softLimitToInt16(floats[i]);
        }
        writer.write(out.subarray(0, n));
        pos += want;
      }
    } catch (err) {
      writer.abort();
      // A half-written WAV must not survive: finalize() reports null for this
      // master, so a leftover `master-<stamp>.wav` would just accumulate in the
      // session dir (mirror the post-encode unlink below).
      try {
        if (existsSync(wavPath)) unlinkSync(wavPath);
      } catch (unlinkErr) {
        logEvent(
          `master mix wav could not be removed (${unlinkErr?.message ?? unlinkErr}); delete ${wavPath} manually`,
        );
      }
      throw err;
    }
    writer.close();
  }
}

/**
 * ffmpeg arg vector for the master encode (exported for tests).
 * Mono + voip: at speech bitrates Opus spends ~half its bits on stereo
 * correlation the mix doesn't need, and voip mode is speech-optimized.
 * @param {string} wavPath
 * @param {string} oggPath
 * @param {string} [bitrate]
 */
export function buildFfmpegArgs(wavPath, oggPath, bitrate = DEFAULT_MASTER_BITRATE) {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    wavPath,
    '-c:a',
    'libopus',
    '-b:a',
    bitrate,
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(MASTER_CHANNELS),
    '-application',
    MASTER_APPLICATION,
    oggPath,
  ];
}

/**
 * @param {string} wavPath
 * @param {string} oggPath
 * @param {string} [bitrate]
 */
export function ffmpegWavToOgg(wavPath, oggPath, bitrate) {
  execFileSync(
    'ffmpeg',
    buildFfmpegArgs(wavPath, oggPath, bitrate),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}