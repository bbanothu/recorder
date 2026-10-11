import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTranscriptionQueue, sidecarName } from '../mobile/src/core/transcription-queue.js';

test('sidecarName: swaps the .m4a extension for .segments.json', () => {
  assert.equal(sidecarName('1000-60000.m4a'), '1000-60000.segments.json');
});

test('runTranscriptionQueue: processes names in order, decode → transcribe → write sidecar', async () => {
  const calls = [];
  await runTranscriptionQueue(['a.m4a', 'b.m4a'], {
    exists: async () => false,
    decode: async (name) => {
      calls.push(['decode', name]);
      return `${name}.wav`;
    },
    transcribe: async (wavPath) => {
      calls.push(['transcribe', wavPath]);
      return { segments: [], language: 'en' };
    },
    writeSidecar: async (name, data) => {
      calls.push(['write', name, data]);
    },
  });
  assert.deepEqual(calls, [
    ['decode', 'a.m4a'],
    ['transcribe', 'a.m4a.wav'],
    ['write', 'a.segments.json', { segments: [], language: 'en' }],
    ['decode', 'b.m4a'],
    ['transcribe', 'b.m4a.wav'],
    ['write', 'b.segments.json', { segments: [], language: 'en' }],
  ]);
});

test('runTranscriptionQueue: a name whose sidecar already exists is skipped — resumable for free', async () => {
  const calls = [];
  await runTranscriptionQueue(['done.m4a', 'todo.m4a'], {
    exists: async (name) => name === 'done.segments.json',
    decode: async (name) => calls.push(['decode', name]) && name,
    transcribe: async () => ({ segments: [] }),
    writeSidecar: async (name) => calls.push(['write', name]),
  });
  assert.deepEqual(calls, [
    ['decode', 'todo.m4a'],
    ['write', 'todo.segments.json'],
  ]);
});

test('runTranscriptionQueue: one chunk failing writes an error sidecar and the queue continues', async () => {
  const written = [];
  await runTranscriptionQueue(['bad.m4a', 'ok.m4a'], {
    exists: async () => false,
    decode: async (name) => {
      if (name === 'bad.m4a') throw new Error('decode exploded');
      return `${name}.wav`;
    },
    transcribe: async () => ({ segments: [] }),
    writeSidecar: async (name, data) => written.push([name, data]),
  });
  assert.deepEqual(written, [
    ['bad.segments.json', { error: 'decode exploded' }],
    ['ok.segments.json', { segments: [] }],
  ]);
});

test('runTranscriptionQueue: reports progress as it goes', async () => {
  const progress = [];
  await runTranscriptionQueue(['a.m4a'], {
    exists: async () => false,
    decode: async (name) => name,
    transcribe: async () => ({ segments: [] }),
    writeSidecar: async () => {},
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(progress, [
    { name: 'a.m4a', status: 'start' },
    { name: 'a.m4a', status: 'done' },
  ]);
});
