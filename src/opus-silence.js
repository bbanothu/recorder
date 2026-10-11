import OpusScript from 'opusscript';

/** @type {Buffer | null} */
let cached = null;

/**
 * One libopus-encoded frame of zero PCM, memoized. Shared by reference across
 * every padded slot: callers must never mutate it.
 * @param {{ sampleRate?: number, channels?: number, samplesPerFrame?: number }} [p]
 */
export function createSilenceFrame({ sampleRate = 48000, channels = 2, samplesPerFrame = 960 } = {}) {
  if (cached) return cached;
  const enc = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
  try {
    cached = Buffer.from(enc.encode(Buffer.alloc(samplesPerFrame * channels * 2), samplesPerFrame));
  } finally {
    enc.delete?.();
  }
  return cached;
}

export function defaultSilenceFrame() {
  return createSilenceFrame();
}
