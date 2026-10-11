import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { createApi } from '../core/api.js';
import { clipRange } from '../core/chunks.js';
import { newDeviceId } from '../core/settings.js';
import { buildLocalClip } from './local-clips';
import { hasModel, nativeTranscriptionAvailable, transcribeClip } from './ondevice-transcribe';
import { listPending, loadSettings, saveSettings } from './storage';
import { sweepPending, uploadPending } from './uploader.js';
import { useChunkRecorder } from './useChunkRecorder.js';

/**
 * App-wide recorder state: lives above the router so recording survives
 * navigation. Uploads hourly while recording (spec), and a clip first closes
 * the current minute and uploads everything pending.
 */

const UPLOAD_EVERY_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Stopgap cloud transcription (spec: phone-recorder-on-device.md) — points
 * at a phone-server by default so Clip gets a transcript out of the box,
 * with no Settings step for the user. On-device transcription needs a
 * dev-client build still; this bridges the gap. Only fills in while
 * Settings has never been saved — a real Settings save always takes over
 * from here on. Sourced from EXPO_PUBLIC_PHONE_* build-time env vars
 * (mobile/.env.local, gitignored — see mobile/.env.local.example) rather
 * than hardcoded here: this file is committed, the server's token is not.
 * Neither var set (the common case for anyone else building this app) is a
 * no-op — same as before this existed.
 */
const DEFAULT_SERVER = {
  serverUrl: process.env.EXPO_PUBLIC_PHONE_SERVER_URL,
  token: process.env.EXPO_PUBLIC_PHONE_TOKEN,
};

const RecorderCtx = createContext(null);

export function RecorderProvider({ children }) {
  const [settings, setSettings] = useState(null);
  const [pending, setPending] = useState(0);
  const [lastUpload, setLastUpload] = useState(null);
  const [error, setError] = useState(null);

  const refreshPending = useCallback(async () => {
    try {
      setPending((await listPending()).length);
    } catch {
      /* storage not ready yet */
    }
  }, []);

  const rec = useChunkRecorder({
    onChunk: refreshPending,
    onError: (err) => setError(`Recorder: ${err?.message ?? err}`),
  });

  useEffect(() => {
    loadSettings().then(async (s) => {
      const next = {
        windowMinutes: DEFAULT_WINDOW_MINUTES,
        transcribeLocally: false,
        ...DEFAULT_SERVER,
        ...s,
        deviceId: s.deviceId || newDeviceId(),
      };
      if (next.deviceId !== s.deviceId) await saveSettings(next);
      setSettings(next);
      refreshPending();
    });
  }, [refreshPending]);

  const configured = Boolean(settings?.serverUrl && settings?.token && settings?.deviceId);
  const api = useMemo(() => (configured ? createApi(settings) : null), [configured, settings]);
  const windowMinutes = settings?.windowMinutes ?? DEFAULT_WINDOW_MINUTES;

  const uploadNow = useCallback(async () => {
    if (!api) throw new Error('Set the server URL and token in Settings first');
    try {
      const sent = await uploadPending(api);
      setLastUpload({ at: Date.now(), sent });
      return sent;
    } catch (err) {
      setLastUpload({ at: Date.now(), error: err?.message ?? String(err) });
      throw err;
    } finally {
      refreshPending();
    }
  }, [api, refreshPending]);

  // Hourly upload and the local retention sweep while recording.
  useEffect(() => {
    if (!rec.recording) return undefined;
    const up = api ? setInterval(() => uploadNow().catch(() => {}), UPLOAD_EVERY_MS) : null;
    const sweep = setInterval(() => {
      sweepPending(windowMinutes).catch(() => {}).then(refreshPending);
    }, SWEEP_EVERY_MS);
    return () => {
      if (up) clearInterval(up);
      clearInterval(sweep);
    };
  }, [rec.recording, api, uploadNow, windowMinutes, refreshPending]);

  // Phase 2 records in the foreground only: keep the screen on meanwhile.
  // Deactivate only what was activated: on the web it throws otherwise.
  const awake = useRef(false);
  useEffect(() => {
    if (rec.recording) {
      awake.current = true;
      activateKeepAwakeAsync('recorder').catch(() => {});
    } else if (awake.current) {
      awake.current = false;
      deactivateKeepAwake('recorder').catch(() => {});
    }
  }, [rec.recording]);

  const updateSettings = useCallback(
    async (patch) => {
      const next = { ...settings, ...patch };
      await saveSettings(next);
      setSettings(next);
      if (next.serverUrl && next.token) {
        await createApi(next).setWindow(next.windowMinutes ?? DEFAULT_WINDOW_MINUTES).catch((err) => {
          setError(`Server: ${err?.message ?? err}`);
        });
      }
    },
    [settings],
  );

  const start = useCallback(async () => {
    setError(null);
    try {
      await rec.start();
      if (api) api.setWindow(windowMinutes).catch((err) => setError(`Server: ${err?.message ?? err}`));
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, [rec, api, windowMinutes]);

  const transcribeLocally = settings?.transcribeLocally === true;

  /**
   * Keep the last `preset` minutes (or 'all'). A local copy is always saved
   * in the background (spec: phone-recorder-on-device.md) — no server
   * required, never blocks navigation.
   *
   * Which clip Clip navigates to depends on the "Transcribe locally"
   * setting: ON skips the server entirely (no upload, no network — the
   * point is not depending on a laptop at all) and goes straight to the
   * local clip, on-device transcription running in the background if this
   * build has it (needs a dev-client build; see nativeTranscriptionAvailable
   * in ondevice-transcribe.js). OFF (default) prefers the server — it's the
   * one that reliably produces a transcript without that build — falling
   * back to the local clip id only if the server call fails. Web has no
   * local clip either way, so there it's always server, unchanged.
   */
  const clip = useCallback(
    async (preset) => {
      await rec.flush();
      const range = clipRange(preset, Date.now(), windowMinutes);

      const localPromise = buildLocalClip(range)
        .then((local) => {
          if (local && nativeTranscriptionAvailable() && hasModel()) {
            transcribeClip(local).catch((err) => setError(`Transcription: ${err?.message ?? err}`));
          }
          return local;
        })
        .catch((err) => {
          setError(`Local clip: ${err?.message ?? err}`);
          return null;
        });

      if (api && !transcribeLocally) {
        try {
          await uploadNow();
          const { clipId } = await api.createClip(range);
          return clipId;
        } catch (err) {
          setError(`Server: ${err?.message ?? err}`);
          // fall through to the local clip below
        }
      }

      const local = await localPromise;
      if (!local) throw new Error('Nothing in the window to clip yet');
      return `local-${local.id}`;
    },
    [api, rec, uploadNow, windowMinutes, transcribeLocally],
  );

  const value = {
    ready: settings != null,
    settings,
    configured,
    api,
    windowMinutes,
    transcribeLocally,
    nativeTranscriptionAvailable: nativeTranscriptionAvailable(),
    recording: rec.recording,
    since: rec.since,
    pending,
    lastUpload,
    error,
    clearError: () => setError(null),
    start,
    stop: rec.stop,
    uploadNow,
    clip,
    updateSettings,
  };
  return <RecorderCtx.Provider value={value}>{children}</RecorderCtx.Provider>;
}

export function useRecorder() {
  const ctx = useContext(RecorderCtx);
  if (!ctx) throw new Error('useRecorder must be used inside <RecorderProvider>');
  return ctx;
}
