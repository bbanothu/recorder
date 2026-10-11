import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeWavFile, openStreamingWavWriter } from '../src/wav.js';

describe('openStreamingWavWriter', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-wavstream-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @param {Int16Array} pcm
   * @param {number[]} chunkSizes
   * @param {string} name
   */
  function streamed(pcm, chunkSizes, name) {
    const path = join(root, name);
    const writer = openStreamingWavWriter(path, { sampleRate: 48000, channels: 2 });
    let pos = 0;
    for (const size of chunkSizes) {
      if (pos >= pcm.length) break;
      writer.write(pcm.subarray(pos, Math.min(pos + size, pcm.length)));
      pos += size;
    }
    writer.close();
    return path;
  }

  it('produces byte-identical output to writeWavFile (chunked at odd sizes)', () => {
    const pcm = new Int16Array(1920 * 3);
    for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 2654435761) % 65536) - 32768;

    const whole = join(root, 'whole.wav');
    writeWavFile(whole, pcm, { sampleRate: 48000, channels: 2 });

    // Deliberately ragged chunk boundaries (not multiples of a frame).
    const chunked = streamed(pcm, [7, 991, 2, 5000, 100000, 3], 'chunked.wav');

    assert.ok(readFileSync(chunked).equals(readFileSync(whole)), 'identical WAV bytes');
  });

  it('closes the fd even when the header-patch write throws (no leaked handle)', () => {
    const path = join(root, 'patchfail.wav');
    /** @type {[string, number][]} */
    const calls = [];
    let nextFd = 1000;
    const fakeFs = {
      openSync(p) {
        calls.push(['open', (nextFd += 1)]);
        return nextFd;
      },
      writeSync(fd, buf, offset, length, position) {
        // The header patch is the only write at an explicit position 0.
        if (position === 0) {
          calls.push(['patch', fd]);
          throw new Error('EPERM: header patch refused');
        }
        calls.push(['write', fd]);
        return buf.length;
      },
      closeSync(fd) {
        calls.push(['close', fd]);
      },
    };

    const writer = openStreamingWavWriter(path, { sampleRate: 48000, channels: 2, fs: fakeFs });
    writer.write(new Int16Array([1, 2, 3, 4]));

    assert.throws(() => writer.close(), /EPERM/, 'the patch failure still surfaces');
    const opened = calls.find(([what]) => what === 'open')[1];
    assert.ok(
      calls.some(([what, fd]) => what === 'close' && fd === opened),
      `the fd was closed despite the failed patch: ${JSON.stringify(calls)}`,
    );
    // Closing again (a caller's abort() after the failed close()) must not
    // close an fd that was already released.
    writer.abort();
    const closes = calls.filter(([what]) => what === 'close');
    assert.equal(closes.length, 1, `exactly one close for fd ${opened}: ${JSON.stringify(calls)}`);
  });

  it('writes a valid header for an empty stream', () => {
    const path = join(root, 'empty.wav');
    const writer = openStreamingWavWriter(path, { sampleRate: 48000, channels: 2 });
    writer.close();
    const buf = readFileSync(path);
    assert.equal(buf.length, 44);
    assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buf.subarray(36, 40).toString(), 'data');
    assert.equal(buf.readUInt32LE(40), 0);
  });
});