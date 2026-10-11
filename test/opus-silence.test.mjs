import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { createSilenceFrame, defaultSilenceFrame } from '../src/opus-silence.js';

describe('opus silence frame', () => {
  it('is a non-empty Buffer that decodes to all-zero 20 ms stereo PCM', () => {
    const frame = createSilenceFrame({ sampleRate: 48000, channels: 2, samplesPerFrame: 960 });
    assert.ok(Buffer.isBuffer(frame));
    assert.ok(frame.length > 0);
    const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const pcm = dec.decode(frame);
    assert.equal(pcm.length, 960 * 2 * 2);
    assert.ok(pcm.every((b) => b === 0));
  });
  it('is memoized: the default accessor returns one shared reference', () => {
    assert.equal(defaultSilenceFrame(), defaultSilenceFrame());
  });
});
