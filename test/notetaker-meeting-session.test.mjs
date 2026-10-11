import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMeetingSession } from '../src/notetaker/meeting-session.js';
import { ALONE_LEAVE_MS } from '../src/notetaker/leave.js';

const T0 = Date.UTC(2026, 9, 5, 18, 30, 0);
const meeting = {
  uid: 'evt-1@google.com',
  platform: 'meet',
  joinUrl: 'https://meet.google.com/eva-ruyy-brw',
  summary: null,
  startsAtMs: T0,
  endsAtMs: T0 + 60 * 60_000,
};

/** A fake world: a call whose page script is driven by `script(i)` per poll. */
function harness({ script, joinError = null, transcribe }) {
  let clock = T0;
  const events = [];
  const files = new Map();
  let poll = 0;
  const page = { id: 'page' };
  const platform = {
    async join(p, opts) {
      events.push(['join', opts.url, opts.botName]);
      if (joinError) throw new Error(joinError);
    },
    async announce(p, text) {
      events.push(['announce', text]);
    },
    async enableCaptions() {
      events.push(['captions-on']);
      return true;
    },
    async status() {
      return script(poll).status;
    },
    async readCaptions() {
      return script(poll).captions ?? [];
    },
    async leave() {
      events.push(['leave']);
    },
  };
  const deps = {
    meetingsDir: '/data',
    botName: 'SpotsLocal Recorder',
    admitTimeoutMs: 600_000,
    platforms: { meet: platform },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      poll += 1;
    },
    mkdir: async () => {},
    appendFile: async (path, data) => {
      files.set(path, (files.get(path) ?? '') + data);
    },
    createSink: async (name) => {
      events.push(['sink', name]);
      return { name, monitor: `${name}.monitor`, remove: async () => events.push(['sink-removed']) };
    },
    openBrowser: async ({ sinkName }) => {
      events.push(['browser', sinkName]);
      return { page, close: async () => events.push(['browser-closed']) };
    },
    startCapture: ({ source, oggPath }) => {
      events.push(['capture', source, oggPath]);
      return { stop: async () => events.push(['capture-stopped']) };
    },
    transcribe,
    writeTranscript: async ({ dir, sessionStartMs, tracks }) => {
      events.push(['transcript', dir, sessionStartMs, tracks]);
      return { mdPath: `${dir}/transcript.md`, segmentCount: 0, withSpeech: 0 };
    },
    log: (m) => events.push(['log', m]),
  };
  return { deps, events, files, at: () => clock };
}

test('runMeetingSession: join → record → leave when alone → Whisper transcript attributed by captions', async () => {
  const caps = [{ id: '1', name: 'Billy', text: 'hello' }];
  const { deps, events, files } = harness({
    script: (i) =>
      i < 3
        ? { status: { inCall: true, participantCount: 2 }, captions: i >= 2 ? caps : [] }
        : { status: { inCall: true, participantCount: 1 }, captions: caps },
    transcribe: async (opts) => {
      events.push(['whisper', opts.masterPath]);
      return { language: 'en', segments: [{ start: 0.5, end: 2, text: 'hello' }, { start: 50, end: 52, text: 'echo' }] };
    },
  });
  const res = await runMeetingSession(meeting, deps);

  assert.equal(res.outcome, 'done');
  assert.match(res.reason, /only participant/);
  const kinds = events.map((e) => e[0]).filter((k) => k !== 'log');
  assert.deepEqual(kinds, [
    'sink', 'browser', 'join', 'capture', 'announce', 'captions-on',
    'leave', 'capture-stopped', 'browser-closed', 'sink-removed', 'whisper', 'transcript',
  ]);
  const sink = events.find((e) => e[0] === 'sink')[1];
  assert.match(sink, /^notetaker_[A-Za-z0-9_]+$/);
  assert.equal(events.find((e) => e[0] === 'browser')[1], sink);
  assert.equal(events.find((e) => e[0] === 'capture')[1], `${sink}.monitor`);
  assert.match(events.find((e) => e[0] === 'capture')[2], /^\/data\/notetaker-meetings\/meeting-20261005-183000-000\/mix-20261005-183000-000\.ogg$/);
  assert.match(events.find((e) => e[0] === 'announce')[1], /recorded and transcribed/);

  const [, , startMs, tracks] = events.find((e) => e[0] === 'transcript');
  assert.equal(startMs, T0);
  assert.deepEqual(
    tracks.map((t) => [t.displayName, t.segments.map((s) => s.text)]),
    [['Billy', ['hello']], [null, ['echo']]],
  );
  // The caption log is written as it arrives.
  const [capPath, capLog] = [...files][0];
  assert.match(capPath, /captions-20261005-183000-000\.jsonl$/);
  assert.deepEqual(JSON.parse(capLog.trim().split('\n')[0]), { t: T0 + 2000, id: '1', name: 'Billy', text: 'hello' });
  // Leaves ALONE_LEAVE_MS after the count first dropped to 1 (poll 3 → 3 s in).
  assert.ok(res.leftAtMs - (T0 + 3000) >= ALONE_LEAVE_MS);
});

test('runMeetingSession: falls back to a captions-only transcript when Whisper fails', async () => {
  const { deps, events } = harness({
    script: (i) => ({
      status: { inCall: i < 4, participantCount: 3 },
      captions: [{ id: '7', name: 'Ana', text: i < 2 ? 'we should' : 'we should ship it' }],
    }),
    transcribe: async () => {
      throw new Error('No module named faster_whisper');
    },
  });
  const res = await runMeetingSession(meeting, deps);
  assert.equal(res.outcome, 'done');
  assert.ok(events.some((e) => e[0] === 'log' && /Whisper failed .*faster_whisper.*captions/.test(e[1])));
  const tracks = events.find((e) => e[0] === 'transcript')[3];
  assert.deepEqual(tracks.map((t) => [t.displayName, t.segments.map((s) => s.text)]), [['Ana', ['we should ship it']]]);
});

test('runMeetingSession: a refused join is a failure that still cleans up and records nothing', async () => {
  const { deps, events } = harness({
    script: () => ({ status: { inCall: false, participantCount: null } }),
    joinError: 'not admitted within 10 min',
    transcribe: async () => assert.fail('nothing to transcribe'),
  });
  const res = await runMeetingSession(meeting, deps);
  assert.equal(res.outcome, 'failed');
  assert.match(res.reason, /not admitted within 10 min/);
  const kinds = events.map((e) => e[0]).filter((k) => k !== 'log');
  assert.deepEqual(kinds, ['sink', 'browser', 'join', 'leave', 'browser-closed', 'sink-removed']);
});

test('runMeetingSession: an unsupported platform fails before touching the browser', async () => {
  const { deps, events } = harness({ script: () => ({}), transcribe: async () => ({}) });
  const res = await runMeetingSession({ ...meeting, platform: 'zoom' }, deps);
  assert.equal(res.outcome, 'failed');
  assert.match(res.reason, /zoom is not supported yet/);
  assert.equal(events.filter((e) => e[0] !== 'log').length, 0);
});
