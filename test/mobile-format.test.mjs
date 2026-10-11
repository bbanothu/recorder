import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../mobile/src/core/format.js';

test('formatBytes: bytes, KB, MB, GB, picking the largest unit that keeps it readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(14 * 1024 * 1024), '14.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
});

test('formatBytes: null/undefined/negative treated as unknown', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(-5), '—');
});
