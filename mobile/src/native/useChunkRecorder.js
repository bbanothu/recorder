import { useRef, useState } from 'react';
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { chunkFileName } from '../core/chunks.js';
import { queueRecording } from './storage';

/** Speech-sized AAC: mono, 16 kHz, 32 kbps ≈ 14 MB/hour. */
export const RECORDING_OPTIONS = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: {},
};

export const CHUNK_MS = 60_000;

/**
 * Record continuously as 1-minute files. Each finished file is moved into the
 * upload queue as `<startedAt>-<durationMs>.m4a`. Rotation stops and restarts
 * the recorder, which leaves a gap of roughly 100 ms per minute (spec: accepted
 * for v1). All recorder work runs through one promise chain so a rotation, a
 * flush and a stop never overlap; the engine is built once per mount and reads
 * the latest callbacks through refs.
 */
export function useChunkRecorder({ onChunk, onError } = {}) {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [recording, setRecording] = useState(false);
  const [since, setSince] = useState(null);
  // Latest callbacks, read at call time: the engine below is built once.
  const callbacks = useRef({});
  callbacks.current = { onChunk, onError, setRecording, setSince };
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  const engine = useRef(null);
  if (!engine.current) {
    let chain = Promise.resolve();
    let timer = null;
    let startedAt = null;
    let active = false;
    const serialize = (fn) => {
      const run = chain.then(fn);
      chain = run.catch(() => {});
      return run;
    };
    const begin = async () => {
      const r = recorderRef.current;
      await r.prepareToRecordAsync();
      r.record();
      startedAt = Date.now();
      timer = setTimeout(rotate, CHUNK_MS);
    };
    const finishCurrent = async () => {
      clearTimeout(timer);
      const start = startedAt;
      startedAt = null;
      if (start == null) return;
      const r = recorderRef.current;
      await r.stop();
      if (r.uri) {
        await queueRecording(r.uri, chunkFileName(start, Math.max(1, Date.now() - start)));
        callbacks.current.onChunk?.();
      }
    };
    function rotate() {
      return serialize(async () => {
        if (!active) return;
        try {
          await finishCurrent();
          await begin();
        } catch (err) {
          callbacks.current.onError?.(err);
          // Try again shortly rather than silently stop listening.
          if (active) timer = setTimeout(rotate, 2000);
        }
      });
    }
    engine.current = {
      start: () =>
        serialize(async () => {
          if (active) return;
          const perm = await requestRecordingPermissionsAsync();
          if (!perm.granted) throw new Error('Microphone permission was not granted');
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          active = true;
          await begin();
          callbacks.current.setRecording(true);
          callbacks.current.setSince(Date.now());
        }),
      stop: () =>
        serialize(async () => {
          if (!active) return;
          active = false;
          await finishCurrent();
          await setAudioModeAsync({ allowsRecording: false });
          callbacks.current.setRecording(false);
          callbacks.current.setSince(null);
        }),
      /** Close the current minute now (before a clip) and keep recording. */
      flush: () => (active ? rotate() : serialize(async () => {})),
    };
  }

  return { recording, since, ...engine.current };
}
