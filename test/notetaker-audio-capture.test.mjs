import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildCaptureArgs,
  sinkNameFor,
  createNullSink,
  startCapture,
} from '../src/notetaker/audio-capture.js';

test('buildCaptureArgs: records the sink monitor as mono voip Opus (AGENTS.md master settings)', () => {
  assert.deepEqual(buildCaptureArgs('nt_abc.monitor', '/d/mix.ogg', '24k'), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'pulse', '-i', 'nt_abc.monitor',
    '-c:a', 'libopus', '-b:a', '24k', '-ar', '48000', '-ac', '1', '-application', 'voip',
    '/d/mix.ogg',
  ]);
});

test('sinkNameFor: a shell-safe PulseAudio sink name', () => {
  assert.equal(sinkNameFor('abc DEF/ghi@x'), 'notetaker_abc_DEF_ghi_x');
  assert.match(sinkNameFor('x'.repeat(200)), /^notetaker_x{1,40}$/);
});

test('createNullSink: loads a null sink and unloads it by module id', async () => {
  const calls = [];
  const execFile = async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout: args[0] === 'load-module' ? '536870913\n' : '' };
  };
  const sink = await createNullSink('notetaker_m1', { execFile });
  assert.equal(sink.monitor, 'notetaker_m1.monitor');
  await sink.remove();
  assert.deepEqual(calls, [
    ['pactl', 'load-module', 'module-null-sink', 'sink_name=notetaker_m1', 'sink_properties=device.description=notetaker_m1'],
    ['pactl', 'unload-module', '536870913'],
  ]);
});

test('startCapture: stop() asks ffmpeg to finish with "q" and resolves with its exit code', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  const written = [];
  child.stdin = { write: (s) => written.push(s), end: () => setImmediate(() => child.emit('close', 0)) };
  child.kill = () => assert.fail('must not kill a cooperative ffmpeg');
  const spawned = [];
  const cap = startCapture({
    source: 's.monitor',
    oggPath: '/d/mix.ogg',
    spawn: (bin, args) => {
      spawned.push([bin, args.at(-1)]);
      return child;
    },
  });
  assert.deepEqual(spawned, [['ffmpeg', '/d/mix.ogg']]);
  assert.equal(await cap.stop(), 0);
  assert.deepEqual(written, ['q']);
});

test('startCapture: an ffmpeg that ignores "q" is killed after the grace period', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  let killed = false;
  child.kill = () => {
    killed = true;
    setImmediate(() => child.emit('close', null));
  };
  const timers = [];
  const cap = startCapture({
    source: 's.monitor',
    oggPath: '/d/mix.ogg',
    spawn: () => child,
    setTimeout: (fn) => {
      timers.push(fn);
      return 1;
    },
    clearTimeout: () => {},
  });
  const done = cap.stop();
  timers.forEach((fn) => fn());
  assert.equal(await done, null);
  assert.equal(killed, true);
});
