import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  formatClock,
  runTranscription, renderCombinedTranscriptMarkdown, combinedTranscriptFileName, clipTranscriptFileName,
  buildTranscodeArgs, transcodeToWav, TRANSCRIBE_TMP_SUFFIX,
} from '../src/transcribe.js';

test('formatClock renders mm:ss under an hour, hh:mm:ss over', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(7.4), '00:07');
  assert.equal(formatClock(65), '01:05');
  assert.equal(formatClock(3601), '01:00:01');
});

/**
 * v3.0.1 Task 2 step 8 (test-only hardening of the Task 1 pin): "every entry is
 * its own markdown block" is asserted against LINE STARTS, not a whole-string
 * scan. The old scan `/[^\n]\n\[/` false-positived whenever ASR text itself
 * contained a newline followed by '[' — faster-whisper `s.text` is passed
 * through raw, so that '[' is inside a spoken body, not an entry boundary.
 * An ENTRY is a line starting with a `[mm:ss]`/`[hh:mm:ss]` stamp; every entry
 * line must be preceded by a blank line (which is also the header/body
 * boundary).
 */
function assertEntriesSeparatedByBlankLines(md, expectedEntries) {
  const stamp = /^\[\d\d:\d\d(:\d\d)?\]/;
  const lines = md.split('\n');
  lines.forEach((line, i) => {
    if (!stamp.test(line)) return;
    assert.equal(
      lines[i - 1],
      '',
      `entry at line ${i} must follow a blank line: ${JSON.stringify(md)}`,
    );
  });
  assert.equal(
    lines.filter((l) => stamp.test(l)).length,
    expectedEntries,
    `expected ${expectedEntries} entry line(s): ${JSON.stringify(md)}`,
  );
}

function fakeSpawn({ code = 0, stdout = '', stderr = '' }) {
  const fn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', 1); };
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    fn.__cmd = cmd; fn.__args = args;
    return child;
  };
  return fn;
}

test('runTranscription: parses segments + language from NDJSON stdout', async () => {
  const spawnFn = fakeSpawn({ stdout: '{"segments":[{"start":0,"end":3.1,"text":"hi"}],"language":"en"}\n' });
  const out = await runTranscription({ spawnFn, transcodeFn: async () => ({ ok: true, decodeErrors: 0 }), pythonBin: 'python', model: 'small', masterPath: 'm.ogg' });
  assert.equal(out.language, 'en');
  assert.deepEqual(out.segments, [{ start: 0, end: 3.1, text: 'hi' }]);
  assert.equal(spawnFn.__cmd, 'python');
  assert.ok(spawnFn.__args.includes(`m${TRANSCRIBE_TMP_SUFFIX}`), 'sidecar reads the canonical WAV, not the raw track');
});

test('runTranscription: translate:true adds --translate (to English) for the sidecar', async () => {
  const spawnFn = fakeSpawn({ stdout: '{"segments":[{"start":0,"end":1,"text":"hello"}],"language":"es"}\n' });
  await runTranscription({
    spawnFn, transcodeFn: async () => ({ ok: true, decodeErrors: 0 }),
    pythonBin: 'python', model: 'small', masterPath: 'm.ogg', translate: true,
  });
  assert.ok(spawnFn.__args.includes('--translate'));
});

test('runTranscription: translate omitted/false never adds the flag', async () => {
  const spawnFn = fakeSpawn({ stdout: '{"segments":[],"language":"en"}\n' });
  await runTranscription({ spawnFn, transcodeFn: async () => ({ ok: true, decodeErrors: 0 }), pythonBin: 'python', model: 'small', masterPath: 'm.ogg' });
  assert.ok(!spawnFn.__args.includes('--translate'));
});

test('runTranscription: non-zero exit rejects', async () => {
  await assert.rejects(
    runTranscription({ spawnFn: fakeSpawn({ code: 1, stderr: 'boom' }), transcodeFn: async () => ({ ok: true, decodeErrors: 0 }), pythonBin: 'p', model: 'm', masterPath: 'x.ogg' }),
    /boom|exit 1/,
  );
});

test('runTranscription: garbage stdout rejects', async () => {
  await assert.rejects(
    runTranscription({ spawnFn: fakeSpawn({ stdout: 'not json' }), transcodeFn: async () => ({ ok: true, decodeErrors: 0 }), pythonBin: 'p', model: 'm', masterPath: 'x.ogg' }),
    /stdout parse/,
  );
});

test('runTranscription: timeout rejects and kills the child', async () => {
  // Fake child that NEVER emits 'close' — only the timeout path can settle.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = 0;
  child.kill = () => { killed++; };
  const spawnFn = () => child;
  await assert.rejects(
    runTranscription({ spawnFn, transcodeFn: async () => ({ ok: true, decodeErrors: 0 }), pythonBin: 'p', model: 'm', masterPath: 'x.ogg', timeoutMs: 5 }),
    /transcription timeout/,
  );
  assert.equal(killed, 1);
});

// --- Task 2: combined speaker-attributed renderer + combined file name ---

test('renderCombinedTranscriptMarkdown interleaves tracks with offsets + speaker labels', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0,
    sourceFile: 'master-12.ogg',
    language: 'en',
    tracks: [
      { displayName: 'Alice', startedAtMs: 0, segments: [{ start: 0, text: ' hello there ' }, { start: 30, text: 'anyone?' }] },
      { displayName: 'Bob', startedAtMs: 10_000, segments: [{ start: 5, text: 'hi alice' }] }, // 5s into his file = 15s session
    ],
  });
  const body = md.split('\n').filter((l) => /^\[\d\d:\d\d(:\d\d)?\]/.test(l));
  assert.deepEqual(body, [
    '[00:00] **Alice:** hello there',
    '[00:15] **Bob:** hi alice',
    '[00:30] **Alice:** anyone?',
  ]);
  assert.match(md, /^# Meeting transcript/);
});

// Task 1 (v3.0.1): entries are blank-line separated. The transcript .md is DM'd
// as an attachment and Discord's in-app preview renders markdown, where a single
// `\n` is a SOFT break: consecutive entries merge into one paragraph, so every
// timestamp runs together. Only a blank line keeps one entry per rendered line.
test('combined render: every entry is its own markdown block (blank-line separated, no lone \\n before an entry)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0,
    sourceFile: 'meeting-1',
    language: 'en',
    tracks: [
      { displayName: 'Alice', startedAtMs: 0, segments: [{ start: 3, text: 'hello there' }, { start: 9, text: 'second line' }] },
      { displayName: 'Bob', startedAtMs: 0, segments: [{ start: 7, text: 'hi' }] },
    ],
  });
  // Each entry starts after a blank line...
  assert.ok(md.includes('\n\n[00:03] '), md);
  assert.ok(md.includes('\n\n[00:07] '), md);
  assert.ok(md.includes('\n\n[00:09] '), md);
  // ...and NO entry is introduced by a LONE newline (exactly the defect: the
  // `\n` before an entry's `[` must itself be preceded by a newline). Anchored
  // to LINE STARTS (step 8), so raw ASR text containing `\n[` cannot trip it.
  assertEntriesSeparatedByBlankLines(md, 3);
  assert.equal(md.match(/\n\[/g).length, 3, 'three entries, each after a blank line');
  // No rendered line carries two entries (the collapsed-paragraph symptom).
  assert.ok(!/\[00:\d\d\][^\n]*\[00:/.test(md), 'no line holds two timestamps');
  // Header/body boundary is a blank line; ordering, clocks and labels kept.
  assert.equal(md, [
    '# Meeting transcript — meeting-1',
    '_language: en_',
    '',
    '[00:03] **Alice:** hello there',
    '',
    '[00:07] **Bob:** hi',
    '',
    '[00:09] **Alice:** second line',
    '',
  ].join('\n'));
  // The nothing-spoken body is unchanged (header + blank line + note).
  assert.equal(
    renderCombinedTranscriptMarkdown({ sessionStartMs: 0, sourceFile: 'meeting-1', language: 'en', tracks: [] }),
    '# Meeting transcript — meeting-1\n_language: en_\n\n_No speech detected._\n',
  );
});

// Task 2 step 8 (test-only hardening of the Task 1 pin): the whole-string scan
// `/[^\n]\n\[/` false-positives when ASR text itself contains a newline
// followed by '[' — faster-whisper `s.text` is passed through raw. And there
// was no one-entry case at all.
test('combined render: one-entry transcript is one blank-line-separated block (Task 2 step 8)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'solo', language: 'en',
    tracks: [{ displayName: 'Solo', startedAtMs: 0, segments: [{ start: 12, text: 'all by myself' }] }],
  });
  assert.equal(md, [
    '# Meeting transcript — solo',
    '_language: en_',
    '',
    '[00:12] **Solo:** all by myself',
    '',
  ].join('\n'));
  assert.ok(md.includes('\n\n[00:12] '), md);
  assert.equal(md.match(/\n\[/g).length, 1, 'one entry, each after a blank line');
  assertEntriesSeparatedByBlankLines(md, 1);
});

test('combined render: ASR text with its own newline + "[" is not an entry boundary (Task 2 step 8)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [{
      displayName: 'Alice',
      startedAtMs: 0,
      segments: [
        { start: 3, text: 'first line\n[aside] second line' },
        { start: 9, text: 'done' },
      ],
    }],
  });
  // The raw ASR body holds a newline followed by '[' — that '[' is INSIDE an
  // entry, never an entry boundary. The old whole-string scan flagged it; the
  // line-start anchor (entries are stamp-led lines) does not.
  assertEntriesSeparatedByBlankLines(md, 2);
});

test('combined render: empty/whitespace segments dropped; all-empty → note', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: null,
    tracks: [
      { displayName: 'X', startedAtMs: 0, segments: [{ start: 1, text: '   ' }] },
      { displayName: 'Y', startedAtMs: 0, segments: [] },
    ],
  });
  assert.match(md, /No speech detected/);
  assert.ok(!/\[00:0[0-9]\]/.test(md), 'no timestamped lines');
});

const tk = (name, file, text) => ({
  displayName: name, startedAtMs: 0, file,
  segments: text ? [{ start: 1, text }] : [],
});

test('combined render (D6a): a text-less track is named once, between header and first entry', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [tk('alice', 'alice-u1.ogg', 'hello'), tk('billy', 'billy-u2.ogg', null)],
  });
  const note = '_No speech recognized for **billy** (billy-u2.ogg)._';
  assert.equal(md.split(note).length - 1, 1);
  assert.ok(md.indexOf(note) > md.indexOf('_language: en_'));
  assert.ok(md.indexOf(note) < md.indexOf('[00:01]'));
  assert.equal(md, `# Meeting transcript — m.ogg\n_language: en_\n\n${note}\n\n[00:01] **alice:** hello\n`);
});

test('combined render (D6b): all tracks text-less keeps the pinned line and appends the notes', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: null,
    tracks: [tk('x', 'x.ogg', null), tk('y', 'y.ogg', '  ')],
    coverage: { rejoinNotes: ['_x: 2 tracks in this meeting (left and rejoined at 00:05); lines are merged under one label._'] },
  });
  assert.equal(
    md,
    '# Meeting transcript — m.ogg\n_language: unknown_\n\n_No speech detected._\n\n'
    + '_No speech recognized for **x** (x.ogg)._\n\n_No speech recognized for **y** (y.ogg)._\n\n'
    + '_x: 2 tracks in this meeting (left and rejoined at 00:05); lines are merged under one label._\n',
  );
});

test('combined render (D6c): rejoin notes render after empty-track notes, before entries', () => {
  const rn = '_billy: 2 tracks in this meeting (left and rejoined at 13:20); lines are merged under one label._';
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [tk('billy', 'billy-u1.ogg', 'hi'), tk('billy', 'billy-u1-2.ogg', null)],
    coverage: { rejoinNotes: [rn] },
  });
  assert.ok(md.indexOf('_No speech recognized for **billy**') < md.indexOf(rn));
  assert.ok(md.indexOf(rn) < md.indexOf('[00:01]'));
  assert.equal(md.split(rn).length - 1, 1);
});

test('combined render (D6d): every track has text and no coverage notes -> byte-identical to the pinned shape', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [tk('a', 'a.ogg', 'one'), tk('b', 'b.ogg', 'two')],
  });
  assert.equal(md, '# Meeting transcript — m.ogg\n_language: en_\n\n[00:01] **a:** one\n\n[00:01] **b:** two\n');
});

test('combinedTranscriptFileName: dir + explicit timestamp (Date or string), Windows and POSIX separators kept', () => {
  assert.equal(
    combinedTranscriptFileName('D:\\m\\', new Date(Date.UTC(2026, 8, 20, 19, 30))),
    'D:\\m\\transcript-2026-09-20_19-30.md',
  );
  assert.equal(
    combinedTranscriptFileName('/data/m', '2026-09-20_19-30'),
    '/data/m/transcript-2026-09-20_19-30.md',
  );
});

test('clipTranscriptFileName: MM-DD-YYYY, both clock times, UTC — not the bot\'s transcript- convention', () => {
  const fromMs = Date.UTC(2026, 9, 10, 15, 33); // Oct 10 2026, 15:33 UTC
  const toMs = Date.UTC(2026, 9, 10, 15, 48);
  assert.equal(clipTranscriptFileName('/data/m', fromMs, toMs), '/data/m/clip_10-10-2026_1533-1548-UTC.md');
  assert.equal(clipTranscriptFileName('D:\\m\\', fromMs, toMs), 'D:\\m\\clip_10-10-2026_1533-1548-UTC.md');
});

test('clipTranscriptFileName: single digits padded, midnight is 0000', () => {
  const fromMs = Date.UTC(2026, 0, 5, 0, 0);
  const toMs = Date.UTC(2026, 0, 5, 9, 5);
  assert.equal(clipTranscriptFileName('/m', fromMs, toMs), '/m/clip_01-05-2026_0000-0905-UTC.md');
});

test('clipTranscriptFileName: a clip crossing midnight UTC is named by its start date', () => {
  const fromMs = Date.UTC(2026, 9, 9, 23, 50);
  const toMs = Date.UTC(2026, 9, 10, 0, 10);
  assert.equal(clipTranscriptFileName('/m', fromMs, toMs), '/m/clip_10-09-2026_2350-0010-UTC.md');
});

test('combined render (i): sessionStartMs is explicit, NOT min-over-tracks — late joiner lands at true meeting time', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0,
    sourceFile: 'm.ogg', language: 'en',
    tracks: [{ displayName: 'Late', startedAtMs: 600_000, segments: [{ start: 0, text: 'did I miss anything' }] }],
  });
  assert.match(md, /^\[10:00\] \*\*Late:\*\* did I miss anything$/m);
});

test('combined render (ii): exact-tie absStart sorts by displayName (Decision 3)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [
      { displayName: 'Zoe', startedAtMs: 5_000, segments: [{ start: 0, text: 'z' }] },   // abs 5s
      { displayName: 'Amy', startedAtMs: 0, segments: [{ start: 5, text: 'a' }] },       // abs 5s — tie
    ],
  });
  const body = md.split('\n').filter((l) => /^\[\d\d:\d\d(:\d\d)?\]/.test(l));
  assert.deepEqual(body, ['[00:05] **Amy:** a', '[00:05] **Zoe:** z']);
});

test('combined render (iii): over-1h clocks render hh:mm:ss in body lines', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [{ displayName: 'A', startedAtMs: 3_600_000, segments: [{ start: 1, text: 'late' }] }],
  });
  const body = md.split('\n').filter((l) => /^\[\d\d:\d\d(:\d\d)?\]/.test(l));
  assert.deepEqual(body, ['[01:00:01] **A:** late']);
});

test('combined render (iv): float segment starts round via formatClock', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [{ displayName: 'A', startedAtMs: 0, segments: [{ start: 10.5, text: 'round me' }] }],
  });
  assert.match(md, /^\[00:11\] \*\*A:\*\* round me$/m); // formatClock Math.round semantics
});

test('combined render (v): negative offset clamps to [00:00], never a negative clock', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 60_000,
    sourceFile: 'm.ogg', language: 'en',
    tracks: [{ displayName: 'Skew', startedAtMs: 55_000, segments: [{ start: 0, text: 'before session start' }] }],
  });
  assert.match(md, /^\[00:00\] \*\*Skew:\*\* before session start$/m);
  assert.ok(!md.includes('[-'));
});

test('combined render (vi): markdown-escaped display names (Decision 8)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [
      { displayName: '**x**', startedAtMs: 0, segments: [{ start: 0, text: 'bold trick' }] },
      { displayName: 'a`b[c', startedAtMs: 0, segments: [{ start: 1, text: 'code trick' }] },
    ],
  });
  assert.ok(md.includes('[00:00] **\\*\\*x\\*\\*:** bold trick'), md);
  assert.ok(md.includes('[00:01] **a\\`b\\[c:** code trick'), md);
});

test('combined render (vii): language header from first non-null track by startedAtMs', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg',
    tracks: [
      { displayName: 'Bob', startedAtMs: 10_000, language: 'zh', segments: [{ start: 0, text: 'ni' }] },
      { displayName: 'Alice', startedAtMs: 0, language: 'en', segments: [{ start: 0, text: 'hi' }] },
    ],
  });
  assert.match(md, /_language: en_/);
});

test('combined render: null-displayName track renders lines without speaker prefix (master-only shape)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'master-x.ogg', language: 'en',
    tracks: [{ displayName: null, startedAtMs: 0, segments: [{ start: 0, text: 'hello' }] }],
  });
  const body = md.split('\n').filter((l) => /^\[\d\d:\d\d(:\d\d)?\]/.test(l));
  assert.deepEqual(body, ['[00:00] hello']);
});


test('combined render: sessionStartMs missing / NaN / Infinity throws TypeError (guard)', () => {
  const mk = (s) => () => renderCombinedTranscriptMarkdown({
    ...s, sourceFile: 'm.ogg',
    tracks: [{ displayName: 'A', startedAtMs: 0, segments: [{ start: 0, text: 'hi' }] }],
  });
  for (const s of [{}, { sessionStartMs: NaN }, { sessionStartMs: Infinity }]) {
    assert.throws(mk(s), TypeError, 'sessionStartMs is required');
  }
});

test('combined render: explicit language param wins over track languages (precedence)', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'fr',
    tracks: [{ displayName: 'A', startedAtMs: 0, language: 'en', segments: [{ start: 0, text: 'bonjour' }] }],
  });
  assert.match(md, /_language: fr_/);
  assert.ok(!md.includes('_language: en_'));
});

test('combined render: non-finite offsets drop the segment, never a [NaN:NaN] line', () => {
  const md = renderCombinedTranscriptMarkdown({
    sessionStartMs: 0, sourceFile: 'm.ogg', language: 'en',
    tracks: [{ displayName: 'A', startedAtMs: NaN, segments: [{ start: 0, text: 'x' }] }],
  });
  assert.ok(!md.includes('[NaN'), md);
  assert.match(md, /No speech detected\./);
});



// --- Task 5 (D8): canonicalise through ffmpeg before the sidecar ---

test('buildTranscodeArgs: 16 kHz mono wav, exact argv', () => {
  assert.deepEqual(buildTranscodeArgs('in.ogg', 'out.wav'), [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', 'in.ogg',
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'out.wav',
  ]);
});

/** spawnFn recording every spawn in order; ffmpeg and python get separate scripted outcomes. */
function recordingSpawn({ ffmpegCode = 0, ffmpegStderr = '', pyCode = 0, pyStdout = '{"segments":[],"language":"en"}' } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const isFfmpeg = cmd === 'ffmpeg';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', 1); };
    process.nextTick(() => {
      const out = isFfmpeg ? '' : pyStdout;
      const err = isFfmpeg ? ffmpegStderr : '';
      if (out) child.stdout.emit('data', Buffer.from(out));
      if (err) child.stderr.emit('data', Buffer.from(err));
      child.emit('close', isFfmpeg ? ffmpegCode : pyCode);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('transcodeToWav: counts decode errors and reports ok', async () => {
  const spawnFn = recordingSpawn({ ffmpegStderr: 'Error parsing the packet header\nInvalid data found when processing input\n' });
  const r = await transcodeToWav({ inputPath: 'a.ogg', wavPath: 'a.wav', spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.decodeErrors, 2);
  assert.equal(spawnFn.calls[0].cmd, 'ffmpeg');
});

test('transcodeToWav: non-zero exit and spawn error are ok:false (never throw)', async () => {
  const bad = await transcodeToWav({ inputPath: 'a.ogg', wavPath: 'a.wav', spawnFn: recordingSpawn({ ffmpegCode: 1, ffmpegStderr: 'nope' }) });
  assert.equal(bad.ok, false);
  const boom = await transcodeToWav({ inputPath: 'a.ogg', wavPath: 'a.wav', spawnFn: () => { throw new Error('ENOENT'); } });
  assert.equal(boom.ok, false);
});

test('runTranscription: transcodes first, sidecar reads the WAV, temp unlinked', async () => {
  const spawnFn = recordingSpawn();
  const unlinked = [];
  const logs = [];
  await runTranscription({
    spawnFn, pythonBin: 'python', model: 'm', masterPath: '/s/Alice-1.ogg',
    unlinkFn: async (p) => { unlinked.push(p); }, log: (m) => logs.push(m),
  });
  assert.deepEqual(spawnFn.calls.map((c) => c.cmd), ['ffmpeg', 'python']);
  const wav = `/s/Alice-1${TRANSCRIBE_TMP_SUFFIX}`;
  assert.ok(spawnFn.calls[0].args.includes(wav));
  assert.ok(spawnFn.calls[1].args.includes(wav));
  assert.ok(!spawnFn.calls[1].args.includes('/s/Alice-1.ogg'));
  assert.deepEqual(unlinked, [wav]);
});

test('runTranscription: logs the decode-error count when non-zero', async () => {
  const logs = [];
  await runTranscription({
    spawnFn: recordingSpawn({ ffmpegStderr: 'Error parsing the packet header\n' }), pythonBin: 'python', model: 'm', masterPath: '/s/A.ogg',
    unlinkFn: async () => {}, log: (m) => logs.push(m),
  });
  assert.equal(logs.filter((l) => /1 decode error/.test(l)).length, 1);
});

test('runTranscription: sidecar failure still unlinks the temp (ok and throw)', async () => {
  const unlinked = [];
  const unlinkFn = async (p) => { unlinked.push(p); };
  await assert.rejects(runTranscription({
    spawnFn: recordingSpawn({ pyCode: 1 }), pythonBin: 'python', model: 'm', masterPath: '/s/A.ogg', unlinkFn, log: () => {},
  }), /exit 1/);
  assert.equal(unlinked.length, 1);
  const throwing = (cmd) => {
    if (cmd === 'ffmpeg') return recordingSpawn()(cmd, []);
    throw new Error('spawn python failed');
  };
  await assert.rejects(runTranscription({
    spawnFn: throwing, pythonBin: 'python', model: 'm', masterPath: '/s/B.ogg', unlinkFn, log: () => {},
  }), /spawn python failed/);
  assert.equal(unlinked.length, 2);
});

test('runTranscription: transcode failure logs once and runs the sidecar on the raw track', async () => {
  const logs = [];
  const unlinked = [];
  const spawnFn = recordingSpawn();
  await runTranscription({
    spawnFn, pythonBin: 'python', model: 'm', masterPath: '/s/A.ogg',
    transcodeFn: async () => ({ ok: false, decodeErrors: 0, stderrTail: 'x' }),
    unlinkFn: async (p) => { unlinked.push(p); }, log: (m) => logs.push(m),
  });
  assert.deepEqual(spawnFn.calls.map((c) => c.cmd), ['python']);
  assert.ok(spawnFn.calls[0].args.includes('/s/A.ogg'));
  assert.equal(logs.length, 1);
});
