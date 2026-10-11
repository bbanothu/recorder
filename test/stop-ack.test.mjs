import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as stopAck from '../src/stop-ack.js';
import { stopAckText } from '../src/stop-ack.js';

// v3.0.1 (spec decision 3): the /stop acknowledgement adapts to the guild's
// stop-time settings so it never promises a DM that will not arrive. The exact
// strings are pinned here — they are documented verbatim and the operator's
// case-1 wording is load-bearing.

const AUDIO_AND_TRANSCRIPT =
  'Stopped. Voice recording and transcription will be sent to your DMs shortly.';
const AUDIO_ONLY = 'Stopped. Voice recording will be sent to your DMs shortly.';
const TRANSCRIPT_ONLY =
  'Stopped. Transcription will be sent to your DMs shortly; the recording is kept on disk (/dm audio TRUE to re-enable).';
const FILES_ONLY =
  'Stopped. Files will be kept on disk (audio DMs are off; /dm audio TRUE to re-enable).';

test('stopAckText: the four-row matrix (exact strings, punctuation included)', () => {
  assert.equal(
    stopAckText({ dmAudioEnabled: true, transcribeEnabled: true, dmTranscribeEnabled: true }),
    AUDIO_AND_TRANSCRIPT,
  );
  // audio on + no transcript DM: either the DM toggle is off or nothing is produced
  assert.equal(
    stopAckText({ dmAudioEnabled: true, transcribeEnabled: true, dmTranscribeEnabled: false }),
    AUDIO_ONLY,
  );
  assert.equal(
    stopAckText({ dmAudioEnabled: true, transcribeEnabled: false, dmTranscribeEnabled: true }),
    AUDIO_ONLY,
  );
  // audio off + transcript DM on
  assert.equal(
    stopAckText({ dmAudioEnabled: false, transcribeEnabled: true, dmTranscribeEnabled: true }),
    TRANSCRIPT_ONLY,
  );
  // audio off + no transcript
  assert.equal(
    stopAckText({ dmAudioEnabled: false, transcribeEnabled: true, dmTranscribeEnabled: false }),
    FILES_ONLY,
  );
  assert.equal(
    stopAckText({ dmAudioEnabled: false, transcribeEnabled: false, dmTranscribeEnabled: true }),
    FILES_ONLY,
  );
});

test('stopAckText: the PRODUCE gate wins — transcribeEnabled:false never promises a transcript', () => {
  // With the produce gate off no transcript file exists at all, so the DM
  // toggle is irrelevant: promising one would be a lie.
  for (const dmTranscribeEnabled of [true, false]) {
    const text = stopAckText({ dmAudioEnabled: true, transcribeEnabled: false, dmTranscribeEnabled });
    assert.equal(text, AUDIO_ONLY, `dmTranscribeEnabled=${dmTranscribeEnabled}`);
    assert.doesNotMatch(text, /transcription/i);
  }
  const off = stopAckText({ dmAudioEnabled: false, transcribeEnabled: false, dmTranscribeEnabled: true });
  assert.equal(off, FILES_ONLY);
  assert.doesNotMatch(off, /transcription will be sent/i);
});

test('stopAckText: undefined inputs — dmAudioEnabled defaults TRUE, the transcript gates default false', () => {
  // dmAudioEnabled is the store's seed default TRUE (send everything); both
  // transcript inputs default false (nothing is promised on a missing read).
  assert.equal(
    stopAckText({ dmAudioEnabled: undefined, transcribeEnabled: undefined, dmTranscribeEnabled: undefined }),
    AUDIO_ONLY,
  );
  assert.equal(stopAckText({}), AUDIO_ONLY);
  assert.equal(stopAckText(), AUDIO_ONLY);
  // transcribeEnabled present but dmTranscribeEnabled missing → not a DM
  assert.equal(stopAckText({ transcribeEnabled: true }), AUDIO_ONLY);
  // dmTranscribeEnabled present but the produce gate missing → not a transcript
  assert.equal(stopAckText({ dmTranscribeEnabled: true }), AUDIO_ONLY);
  // an explicit dmAudioEnabled:true is unchanged by the default
  assert.equal(
    stopAckText({ dmAudioEnabled: true, transcribeEnabled: true, dmTranscribeEnabled: true }),
    AUDIO_AND_TRANSCRIPT,
  );
});

test('stopAckText: inputs are coerced with Boolean()', () => {
  // A truthy non-boolean read is not a false one; a 0/null read is (null is an
  // explicit off, NOT the undefined default).
  assert.equal(
    stopAckText({ dmAudioEnabled: 1, transcribeEnabled: 'TRUE', dmTranscribeEnabled: 1 }),
    AUDIO_AND_TRANSCRIPT,
  );
  assert.equal(
    stopAckText({ dmAudioEnabled: 0, transcribeEnabled: true, dmTranscribeEnabled: true }),
    TRANSCRIPT_ONLY,
  );
  assert.equal(
    stopAckText({ dmAudioEnabled: null, transcribeEnabled: false, dmTranscribeEnabled: false }),
    FILES_ONLY,
  );
  assert.equal(
    stopAckText({ dmAudioEnabled: false, transcribeEnabled: '', dmTranscribeEnabled: true }),
    FILES_ONLY,
  );
});

// v3.0.1 Task 2b: the /stop pipeline runs in the background, so a HARD failure
// (a non-forbidden delivery throw, a throw before the channel notice, …) has no
// command-error handler left to reach. One exported line is the terminal state
// the operator sees instead of a stale "…shortly." — pinned verbatim, single
// source (bot.js imports it; it is never re-typed there).
test('STOP_FAILED_TEXT: the single-source terminal-failure line is pinned verbatim', () => {
  assert.equal(
    stopAck.STOP_FAILED_TEXT,
    'Stopped. Something went wrong processing the recording — check the console output.',
  );
  // It is a TERMINAL state, never a promise: it must not be confusable with any
  // of the four acknowledgement strings.
  for (const ack of [AUDIO_AND_TRANSCRIPT, AUDIO_ONLY, TRANSCRIPT_ONLY, FILES_ONLY]) {
    assert.notEqual(ack, stopAck.STOP_FAILED_TEXT);
  }
  // "shortly" is the promise wording the stale ack is stuck on — the failure
  // line must never carry it.
  assert.doesNotMatch(stopAck.STOP_FAILED_TEXT, /shortly/);
});
