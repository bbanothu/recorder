import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConcatList, buildConcatArgs } from '../src/phone/audio.js';

test('buildConcatList: one ffmpeg concat line per file, single quotes escaped', () => {
  assert.equal(buildConcatList(['/a/1.m4a', "/b/it's.m4a"]), "file '/a/1.m4a'\nfile '/b/it'\\''s.m4a'\n");
});

test('buildConcatArgs: stream-copy concat (no re-encode)', () => {
  assert.deepEqual(buildConcatArgs('/c/list.txt', '/c/clip.m4a'), [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', '/c/list.txt', '-c', 'copy', '/c/clip.m4a',
  ]);
});
