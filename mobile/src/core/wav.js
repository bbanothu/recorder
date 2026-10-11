/**
 * Minimal 44-byte RIFF/WAVE PCM header (same layout as src/wav.js's
 * `wavHeaderBytes`, ported rather than imported — mobile is its own Metro
 * project and can't reach across to the server-side package). Built on
 * ArrayBuffer/DataView, not node:Buffer, so it runs on-device and in tests
 * alike. whisper.rn needs 16-bit PCM WAV input — this is the piece of that
 * pipeline that doesn't depend on any native module and so is fully tested.
 */
export function wavHeaderBytes({ dataSize, sampleRate = 16000, channels = 1, bitsPerSample = 16 }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) bytes[offset + i] = str.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

/**
 * Web Audio's Float32 samples (-1..1, AudioBuffer.getChannelData) → Int16
 * PCM. Clamped rather than wrapped: a decoder handing back a sample just
 * outside -1..1 is its own rounding quirk, not a real clip, and wrapping it
 * would turn a quiet moment into a loud pop.
 * @param {Float32Array} float32
 */
export function floatToInt16Pcm(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Int16 PCM samples (interleaved) → a complete WAV file's bytes. Defaults
 * (16 kHz mono) match whisper.rn's expected input.
 * @param {Int16Array} samples
 * @param {{ sampleRate?: number, channels?: number }} [opts]
 */
export function pcmToWav(samples, { sampleRate = 16000, channels = 1 } = {}) {
  const header = wavHeaderBytes({ dataSize: samples.length * 2, sampleRate, channels });
  const out = new Uint8Array(header.length + samples.length * 2);
  out.set(header, 0);
  const view = new DataView(out.buffer, header.length);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}
