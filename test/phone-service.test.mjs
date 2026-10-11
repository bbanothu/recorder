import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhoneStore } from '../src/phone/store.js';
import { createPhoneService } from '../src/phone/service.js';

const MIN = 60_000;
const T = Date.UTC(2026, 9, 6, 12, 0, 0);

function setup({ transcribe, concatAudio } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phone-svc-'));
  let clock = T;
  const logs = [];
  const transcribed = [];
  const concat = [];
  const store = createPhoneStore(new DatabaseSync(':memory:'), { now: () => new Date(clock), defaultWindowMinutes: 60 });
  const svc = createPhoneService({
    store,
    root,
    now: () => clock,
    log: (m) => logs.push(m),
    transcribe:
      transcribe ??
      (async ({ masterPath }) => {
        transcribed.push(masterPath);
        return { language: 'en', segments: [{ start: 1, end: 3, text: `said in ${masterPath.split('/').pop()}` }] };
      }),
    concatAudio:
      concatAudio ??
      (async (paths, out) => {
        concat.push([paths.map((p) => p.split('/').pop()), out]);
      }),
  });
  return {
    root, store, svc, logs, transcribed, concat,
    setClock: (ms) => { clock = ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('receiveChunk: stores the audio once, transcribes it, segments land on the absolute clock', async () => {
  const h = setup();
  try {
    assert.equal(await h.svc.receiveChunk('pixel', T, MIN, Buffer.from('aac')), 'created');
    assert.equal(await h.svc.receiveChunk('pixel', T, MIN, Buffer.from('aac')), 'exists');
    await h.svc.idle();
    const audio = join(h.root, 'pixel', 'chunks', `${T}.m4a`);
    assert.equal(readFileSync(audio, 'utf8'), 'aac');
    assert.deepEqual(h.transcribed, [audio]);
    const [chunk] = h.store.chunksOverlapping('pixel', T, T + MIN);
    assert.equal(chunk.state, 'transcribed');
    const segs = JSON.parse(readFileSync(chunk.segmentsPath, 'utf8'));
    assert.deepEqual(segs, { language: 'en', segments: [{ startMs: T + 1000, endMs: T + 3000, text: `said in ${T}.m4a` }] });
  } finally {
    h.cleanup();
  }
});

test('receiveChunk: rejects unsafe device ids and bad times (they reach the filesystem)', async () => {
  const h = setup();
  try {
    await assert.rejects(h.svc.receiveChunk('../etc', T, MIN, Buffer.from('x')), /deviceId/);
    await assert.rejects(h.svc.receiveChunk('p', -5, MIN, Buffer.from('x')), /startedAt/);
    await assert.rejects(h.svc.receiveChunk('p', T, 0, Buffer.from('x')), /durationMs/);
    await assert.rejects(h.svc.receiveChunk('p', T, MIN, Buffer.alloc(0)), /empty/);
  } finally {
    h.cleanup();
  }
});

test('a failed transcription marks the chunk failed and the queue keeps going', async () => {
  let n = 0;
  const h = setup({
    transcribe: async () => {
      n += 1;
      if (n === 1) throw new Error('whisper exploded');
      return { language: 'en', segments: [] };
    },
  });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    await h.svc.receiveChunk('p', T + MIN, MIN, Buffer.from('b'));
    await h.svc.idle();
    assert.deepEqual(h.store.chunksOverlapping('p', T, T + 2 * MIN).map((c) => c.state), ['failed', 'transcribed']);
    assert.ok(h.logs.some((l) => /whisper exploded/.test(l)));
  } finally {
    h.cleanup();
  }
});

test('clip: waits for transcription, keeps only segments in range, renders markdown and keeps the audio', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a')); // segment at T+1s
    await h.svc.receiveChunk('p', T + MIN, MIN, Buffer.from('b')); // segment at T+61s
    await h.svc.receiveChunk('p', T + 2 * MIN, MIN, Buffer.from('c')); // outside the clip
    const id = h.svc.createClip('p', T + 30_000, T + 2 * MIN);
    assert.equal(h.store.getClip('p', id).state, 'pending');
    await h.svc.idle();
    await h.svc.finalizeClips();
    const clip = h.store.getClip('p', id);
    assert.equal(clip.state, 'ready');
    const md = readFileSync(clip.mdPath, 'utf8');
    assert.match(md, new RegExp(`\\[00:31\\] said in ${T + MIN}\\.m4a`));
    assert.doesNotMatch(md, new RegExp(`said in ${T}\\.m4a`)); // T+1s is before the clip
    assert.doesNotMatch(md, new RegExp(`said in ${T + 2 * MIN}\\.m4a`));
    assert.deepEqual(h.concat[0][0], [`${T}.m4a`, `${T + MIN}.m4a`]);
    assert.equal(h.concat[0][1], clip.audioPath);
  } finally {
    h.cleanup();
  }
});

test('clip: rejects a range that is empty, inverted or longer than 24 h', () => {
  const h = setup();
  try {
    assert.throws(() => h.svc.createClip('p', T, T), /range/);
    assert.throws(() => h.svc.createClip('p', T, T - 1), /range/);
    assert.throws(() => h.svc.createClip('p', T, T + 25 * 60 * MIN), /range/);
  } finally {
    h.cleanup();
  }
});

test('deleteClip: removes the clip and its files; unknown id is a no-op (false)', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    const clip = h.store.getClip('p', id);
    assert.equal(existsSync(clip.mdPath), true); // setup()'s concatAudio mock doesn't write audioPath, so only mdPath is real

    assert.equal(await h.svc.deleteClip('p', id), true);
    assert.equal(h.store.getClip('p', id), null);
    assert.equal(existsSync(clip.mdPath), false);
    assert.equal(existsSync(join(h.root, 'p', 'clips', String(id))), false); // whole dir gone

    assert.equal(await h.svc.deleteClip('p', id), false); // already gone
    assert.equal(await h.svc.deleteClip('other', id), false); // wrong device
  } finally {
    h.cleanup();
  }
});

test('deleteAllClips: removes every clip for the device, leaves other devices alone', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    await h.svc.receiveChunk('q', T, MIN, Buffer.from('b'));
    const a = h.svc.createClip('p', T, T + MIN);
    const b = h.svc.createClip('p', T, T + MIN);
    const c = h.svc.createClip('q', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();

    assert.equal(await h.svc.deleteAllClips('p'), 2);
    assert.deepEqual(h.store.listClips('p'), []);
    assert.equal(h.store.listClips('q').length, 1);
    assert.equal(existsSync(join(h.root, 'p', 'clips', String(a))), false);
    assert.equal(existsSync(join(h.root, 'p', 'clips', String(b))), false);
    assert.equal(existsSync(h.store.getClip('q', c).mdPath), true); // q's clip untouched
  } finally {
    h.cleanup();
  }
});

test('translateClip: runs Whisper\'s translate task on the clip\'s audio, caches the result', async () => {
  let translateCalls = 0;
  const h = setup({
    transcribe: async ({ masterPath, translate }) => {
      if (!translate) return { language: 'es', segments: [{ start: 0, end: 1, text: 'hola' }] };
      translateCalls += 1;
      return { language: 'es', segments: [{ start: 0, end: 1, text: `EN of ${masterPath.split('/').pop()}` }] };
    },
  });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    assert.equal(h.store.getClip('p', id).language, 'es');

    const first = await h.svc.translateClip('p', id);
    assert.match(first.translatedMarkdown, /EN of clip\.m4a/);
    assert.equal(translateCalls, 1);
    assert.ok(h.store.getClip('p', id).translatedMdPath);

    const second = await h.svc.translateClip('p', id);
    assert.equal(second.translatedMarkdown, first.translatedMarkdown);
    assert.equal(translateCalls, 1); // cached: no second Whisper run
  } finally {
    h.cleanup();
  }
});

test('translateClip: a clip already in English reuses its own transcript — no Whisper rerun', async () => {
  let calls = 0;
  const h = setup({ transcribe: async (opts) => { calls += 1; return { language: 'en', segments: opts.translate ? [] : [{ start: 0, end: 1, text: 'hi' }] }; } });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    assert.equal(calls, 1); // only the original transcription so far
    const { translatedMarkdown } = await h.svc.translateClip('p', id);
    assert.equal(calls, 1); // still 1: translate was skipped for an already-English clip
    assert.equal(translatedMarkdown, readFileSync(h.store.getClip('p', id).mdPath, 'utf8'));
  } finally {
    h.cleanup();
  }
});

test('translateClip: no audio to translate, or clip not ready / not found', async () => {
  const h = setup({
    transcribe: async () => ({ language: 'es', segments: [{ start: 0, end: 1, text: 'hola' }] }),
    concatAudio: async () => { throw new Error('concat unavailable'); },
  });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    assert.equal(h.store.getClip('p', id).audioPath, null); // concat failed, logged, transcript still saved
    await assert.rejects(h.svc.translateClip('p', id), /audio/i);

    const pendingId = h.svc.createClip('p', T, T + MIN);
    await assert.rejects(h.svc.translateClip('p', pendingId), /not ready/i);

    assert.equal(await h.svc.translateClip('p', 999), null);
  } finally {
    h.cleanup();
  }
});

test('getClip/listClips report real file sizes, 0 for missing/null paths', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    const clip = await h.svc.getClip('p', id);
    assert.equal(clip.audioSizeBytes, 0); // setup()'s concatAudio mock never writes a real file
    assert.ok(clip.mdSizeBytes > 0); // the markdown really was written

    const [listed] = await h.svc.listClips('p');
    assert.equal(listed.mdSizeBytes, clip.mdSizeBytes);
    assert.equal(listed.audioSizeBytes, 0);
  } finally {
    h.cleanup();
  }
});

test('redoClip: re-transcribes from the clip\'s audio, overwrites the same file, invalidates a cached translation', async () => {
  let pass = 0;
  const h = setup({
    transcribe: async ({ translate }) => {
      pass += 1;
      if (translate) return { language: 'en', segments: [{ start: 0, end: 1, text: 'old translation' }] };
      return { language: 'en', segments: [{ start: 0, end: 1, text: pass === 1 ? 'first pass' : 'redone pass' }] };
    },
  });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    const before = h.store.getClip('p', id);
    assert.match(readFileSync(before.mdPath, 'utf8'), /first pass/);
    await h.svc.translateClip('p', id); // give it a cached translation to invalidate
    assert.ok(h.store.getClip('p', id).translatedMdPath);

    const { markdown } = await h.svc.redoClip('p', id);
    assert.match(markdown, /redone pass/);
    const after = h.store.getClip('p', id);
    assert.equal(after.mdPath, before.mdPath); // same file, overwritten in place
    assert.match(readFileSync(after.mdPath, 'utf8'), /redone pass/);
    assert.equal(after.translatedMdPath, null); // stale translation invalidated

    assert.equal(await h.svc.redoClip('p', 999), null);
  } finally {
    h.cleanup();
  }
});

test('updateClipMarkdown: overwrites an existing transcript file in place, or creates one if it was deleted', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    const originalPath = h.store.getClip('p', id).mdPath;

    assert.equal(await h.svc.updateClipMarkdown('p', id, '# edited by hand\n'), true);
    assert.equal(h.store.getClip('p', id).mdPath, originalPath); // same file
    assert.equal(readFileSync(originalPath, 'utf8'), '# edited by hand\n');

    await h.svc.deleteClipText('p', id);
    assert.equal(h.store.getClip('p', id).mdPath, null);
    assert.equal(await h.svc.updateClipMarkdown('p', id, '# back from nothing\n'), true);
    const revived = h.store.getClip('p', id).mdPath;
    assert.ok(revived);
    assert.equal(readFileSync(revived, 'utf8'), '# back from nothing\n');

    assert.equal(await h.svc.updateClipMarkdown('p', 999, 'x'), false);
    await assert.rejects(h.svc.updateClipMarkdown('p', id, 42), /markdown must be a string/);
  } finally {
    h.cleanup();
  }
});

test('deleteClipAudio / deleteClipText: each clears only its own field and file, the other survives', async () => {
  const h = setup();
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    const id = h.svc.createClip('p', T, T + MIN);
    await h.svc.idle();
    await h.svc.finalizeClips();
    const clip = h.store.getClip('p', id);
    assert.ok(clip.mdPath);

    assert.equal(await h.svc.deleteClipAudio('p', id), true);
    const afterAudio = h.store.getClip('p', id);
    assert.equal(afterAudio.audioPath, null);
    assert.equal(afterAudio.mdPath, clip.mdPath);
    assert.equal(existsSync(clip.mdPath), true); // transcript untouched

    assert.equal(await h.svc.deleteClipText('p', id), true);
    const afterText = h.store.getClip('p', id);
    assert.equal(afterText.mdPath, null);
    assert.equal(existsSync(clip.mdPath), false);

    assert.equal(await h.svc.deleteClipAudio('p', 999), false);
    assert.equal(await h.svc.deleteClipText('p', 999), false);
  } finally {
    h.cleanup();
  }
});

test('sweep: deletes chunks past the window, but never ones a pending clip still needs', async () => {
  const h = setup();
  try {
    h.svc.setWindow('p', 30);
    await h.svc.receiveChunk('p', T - 50 * MIN, MIN, Buffer.from('old'));
    await h.svc.receiveChunk('p', T - 45 * MIN, MIN, Buffer.from('pinned'));
    await h.svc.receiveChunk('p', T - 5 * MIN, MIN, Buffer.from('fresh'));
    await h.svc.idle();
    h.svc.createClip('p', T - 45 * MIN, T - 44 * MIN); // pending until finalizeClips
    const removed = await h.svc.sweep();
    assert.equal(removed, 1);
    assert.equal(existsSync(join(h.root, 'p', 'chunks', `${T - 50 * MIN}.m4a`)), false);
    assert.equal(existsSync(join(h.root, 'p', 'chunks', `${T - 50 * MIN}.segments.json`)), false);
    assert.equal(existsSync(join(h.root, 'p', 'chunks', `${T - 45 * MIN}.m4a`)), true);
    await h.svc.finalizeClips();
    assert.equal(await h.svc.sweep(), 1); // the clip has its own copy now
    assert.equal(existsSync(join(h.root, 'p', 'chunks', `${T - 5 * MIN}.m4a`)), true);
  } finally {
    h.cleanup();
  }
});

test('sweep: never deletes a chunk still waiting to be transcribed, even if it arrived already stale', async () => {
  // A phone can upload a backlog of chunks it recorded long before it ever
  // reached a server (hourly upload, or a big batch right before a Clip).
  // receiveChunk doesn't reject a chunk whose startedAt is already outside
  // the window — it queues it like any other. Without this, a slow/queued
  // transcription loses the race against the next sweep, which deleted the
  // file out from under it (real bug: "Error opening input file ... No
  // such file or directory").
  let release;
  const stuck = new Promise((r) => { release = r; });
  const h = setup({ transcribe: async () => { await stuck; return { language: 'en', segments: [] }; } });
  try {
    h.svc.setWindow('p', 30);
    // Already 50 min old — outside the 30 min window — at the moment it's
    // received. receiveChunk resolves once the chunk is stored and queued,
    // without waiting for transcription (that's the whole point of the
    // queue) — so awaiting it here still leaves the transcribe() call
    // itself stuck on `stuck` below.
    await h.svc.receiveChunk('p', T - 50 * MIN, MIN, Buffer.from('stale-but-queued'));
    assert.equal(await h.svc.sweep(), 0); // still 'received': not swept
    assert.equal(existsSync(join(h.root, 'p', 'chunks', `${T - 50 * MIN}.m4a`)), true);
    release();
    await h.svc.idle();
    assert.equal(h.store.chunksOverlapping('p', T - 50 * MIN, T - 49 * MIN)[0].state, 'transcribed');
    assert.equal(await h.svc.sweep(), 1); // now it's had its chance
  } finally {
    h.cleanup();
  }
});

test('createClip: retries chunks whose transcription failed before, every time', async () => {
  // Clipping the same audio again should mean another real attempt — a
  // chunk that failed once (whisper hiccup, a bug since fixed) otherwise
  // stays failed forever and silently contributes nothing to every later
  // clip over that range.
  let attempts = 0;
  const h = setup({
    transcribe: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('whisper hiccup');
      return { language: 'en', segments: [{ start: 0, end: 1, text: 'second time lucky' }] };
    },
  });
  try {
    await h.svc.receiveChunk('p', T, MIN, Buffer.from('a'));
    await h.svc.idle();
    assert.equal(h.store.chunksOverlapping('p', T, T + MIN)[0].state, 'failed');

    const id = h.svc.createClip('p', T, T + MIN); // the retry trigger
    await h.svc.idle();
    assert.equal(attempts, 2);
    assert.equal(h.store.chunksOverlapping('p', T, T + MIN)[0].state, 'transcribed');

    await h.svc.finalizeClips();
    assert.match(readFileSync(h.store.getClip('p', id).mdPath, 'utf8'), /second time lucky/);
  } finally {
    h.cleanup();
  }
});

test('setWindow: only whole minutes from 1 to 1440', () => {
  const h = setup();
  try {
    assert.equal(h.svc.setWindow('p', 720), 720);
    assert.throws(() => h.svc.setWindow('p', 0), /windowMinutes/);
    assert.throws(() => h.svc.setWindow('p', 1441), /windowMinutes/);
    assert.throws(() => h.svc.setWindow('p', 1.5), /windowMinutes/);
  } finally {
    h.cleanup();
  }
});

test('resume: chunks left "received" by a restart are transcribed again', async () => {
  const h = setup();
  try {
    h.store.addChunk({ deviceId: 'p', startedAt: T, durationMs: MIN, path: join(h.root, 'x.m4a') });
    h.svc.resume();
    await h.svc.idle();
    assert.equal(h.transcribed.length, 1);
  } finally {
    h.cleanup();
  }
});
