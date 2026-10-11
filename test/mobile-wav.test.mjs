import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatToInt16Pcm, pcmToWav, wavHeaderBytes } from '../mobile/src/core/wav.js';

test('wavHeaderBytes: 44-byte canonical RIFF/WAVE PCM header', () => {
  const h = wavHeaderBytes({ dataSize: 100, sampleRate: 16000, channels: 1 });
  assert.equal(h.length, 44);
  const text = (from, len) => String.fromCharCode(...h.slice(from, from + len));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(text(36, 4), 'data');
  const view = new DataView(h.buffer);
  assert.equal(view.getUint32(4, true), 36 + 100); // RIFF chunk size
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // channels
  assert.equal(view.getUint32(24, true), 16000); // sample rate
  assert.equal(view.getUint32(28, true), 16000 * 2); // byte rate (mono 16-bit)
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), 100); // data chunk size
});

test('pcmToWav: header + little-endian int16 samples, round-trips through a DataView', () => {
  const samples = new Int16Array([0, 32767, -32768, -1, 1234]);
  const wav = pcmToWav(samples, { sampleRate: 16000, channels: 1 });
  assert.equal(wav.length, 44 + samples.length * 2);
  const view = new DataView(wav.buffer);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(view.getInt16(44 + i * 2, true), samples[i]);
  }
});

test('pcmToWav: default sample rate/channels match whisper.rn\'s expected 16 kHz mono', () => {
  const wav = pcmToWav(new Int16Array([1]));
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
});

test('floatToInt16Pcm: scales Web Audio\'s -1..1 Float32 samples to Int16 range', () => {
  const out = floatToInt16Pcm(new Float32Array([0, 1, -1, 0.5, -0.5]));
  assert.ok(out instanceof Int16Array);
  assert.deepEqual([...out], [0, 32767, -32768, 16383, -16384]);
});

test('floatToInt16Pcm: out-of-range samples (a decoder quirk, not spec) are clamped, not wrapped', () => {
  assert.deepEqual([...floatToInt16Pcm(new Float32Array([2, -2]))], [32767, -32768]);
});
