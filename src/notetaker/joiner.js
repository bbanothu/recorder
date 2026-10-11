import { mkdir, appendFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { logEvent } from '../log.js';
import { runTranscription, defaultPythonBin } from '../transcribe.js';
import { writeTranscript } from '../transcript-pipeline.js';
import { createNullSink, startCapture } from './audio-capture.js';
import { openBrowser, resolveChromePath } from './browser.js';
import { runMeetingSession } from './meeting-session.js';
import { meet } from './platforms/meet.js';

/**
 * Real-world wiring for runMeetingSession: Chrome, PulseAudio, ffmpeg and the
 * Whisper sidecar. Shared by the scheduler (index.js) and `notetaker:join`.
 * @param {ReturnType<typeof import('./env.js').loadNotetakerEnv>} env
 */
export function createJoiner(env, { log = logEvent } = {}) {
  const chromePath = resolveChromePath(env.NOTETAKER_CHROME_PATH);
  return (meeting, { onRecording } = {}) =>
    runMeetingSession(meeting, {
      meetingsDir: env.MEETINGS_DIR,
      botName: env.NOTETAKER_BOT_NAME,
      admitTimeoutMs: env.NOTETAKER_ADMIT_TIMEOUT_MIN * 60_000,
      platforms: { meet },
      openBrowser: ({ sinkName }) =>
        openBrowser({ profileDir: env.NOTETAKER_BROWSER_PROFILE, chromePath, headless: env.NOTETAKER_HEADLESS, sinkName }),
      createSink: (name) => createNullSink(name),
      startCapture,
      transcribe: (opts) =>
        runTranscription({
          pythonBin: env.WHISPER_PYTHON || defaultPythonBin(),
          cacheDir: process.env.HF_HOME || undefined,
          ...opts,
        }),
      transcribeOpts: { model: env.WHISPER_MODEL },
      writeTranscript,
      mkdir,
      appendFile,
      sleep,
      onRecording,
      log,
    });
}
