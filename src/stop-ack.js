/**
 * The `/stop` acknowledgement (v3.0.1, spec decision 3): the operator sees it
 * IMMEDIATELY, before the slow stop pipeline (the ffmpeg encode inside
 * `MasterMix#finalize()` is ~37 s per hour of meeting) starts, so it must never
 * promise a DM that will not arrive.
 *
 * Inputs are the STOP-TIME guild config snapshot (the same snapshot the stop
 * pipeline uses for its audio DM rule and its transcript DM gate):
 * - `dmAudioEnabled` — the audio DM toggle. MISSING means TRUE (that is the
 *   store's seed default: send everything).
 * - `transcribeEnabled && dmTranscribeEnabled` — a transcript DM is coming.
 *   The PRODUCE gate wins: with `transcribeEnabled: false` no transcript file
 *   is written at all, so `dmTranscribeEnabled` cannot make one appear. Both
 *   missing/undefined mean FALSE (nothing is promised on a missing read).
 *
 * Pure decision logic in its own module (AGENTS.md): no I/O, no imports, so it
 * is unit-tested without wiring. The strings are pinned verbatim by
 * test/stop-ack.test.mjs — keep the punctuation identical.
 *
 * @param {{ dmAudioEnabled?: boolean, transcribeEnabled?: boolean, dmTranscribeEnabled?: boolean }} [cfg]
 * @returns {string} the ephemeral ack the /stop interaction replies with
 */
export function stopAckText({ dmAudioEnabled, transcribeEnabled, dmTranscribeEnabled } = {}) {
  // Missing = the seed default TRUE; anything present is judged by truthiness.
  const audio = dmAudioEnabled === undefined ? true : Boolean(dmAudioEnabled);
  const transcript = Boolean(transcribeEnabled) && Boolean(dmTranscribeEnabled);

  if (audio && transcript) {
    return 'Stopped. Voice recording and transcription will be sent to your DMs shortly.';
  }
  if (audio) {
    return 'Stopped. Voice recording will be sent to your DMs shortly.';
  }
  if (transcript) {
    return 'Stopped. Transcription will be sent to your DMs shortly; the recording is kept on disk (/dm audio TRUE to re-enable).';
  }
  return 'Stopped. Files will be kept on disk (audio DMs are off; /dm audio TRUE to re-enable).';
}

/**
 * v3.0.1 Task 2b — the TERMINAL state of a `/stop` whose background pipeline
 * died hard: a non-forbidden delivery throw (deliver.js rethrows those before
 * it replies) or any throw before the channel notice (e.g. `recorder.stop()`).
 * index.js's command-error handler no longer sees those throws — nothing awaits
 * the pipeline any more — so without this line the operator's ack would stay on
 * "…shortly." forever and only the console would know.
 *
 * Single source: src/bot.js imports it for the best-effort ack edit — the text
 * is never re-typed there. It is a failure line, never a promise: it must not
 * be confusable with any of the four acknowledgements above and never carries
 * the word "shortly" (both pinned in test/stop-ack.test.mjs).
 *
 * LIMIT (documented, not claimed away): if the interaction token has expired
 * the edit itself cannot land (Discord 10062), so the ack stays stale even
 * though the console logs the failure. The DM is not token-bound, so this can
 * happen while the recording was in fact delivered — the channel notice (when
 * the pipeline reached it) is the remaining operator-facing truth in that
 * window.
 */
export const STOP_FAILED_TEXT =
  'Stopped. Something went wrong processing the recording — check the console output.';
