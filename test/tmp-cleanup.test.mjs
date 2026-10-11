import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepStaleMixTemps, MIX_TMP_SUFFIX, TRANSCRIBE_TMP_SUFFIX } from '../src/tmp-cleanup.js';

/**
 * A realistic recordings tree: two guilds, a finished session each, plus one
 * crash-residue temp in a nested meeting dir.
 * @param {string} root
 */
function plantTree(root) {
  const m1 = join(root, 'discord-meetings', '123456789012345678', 'meeting-2026-09-18-21-00-00');
  const m2 = join(root, 'discord-meetings', '987654321098765432', 'meeting-2026-09-18-22-00-00');
  mkdirSync(m1, { recursive: true });
  mkdirSync(m2, { recursive: true });
  const artifacts = [
    join(m1, 'master-20260918-210000-000.ogg'),
    join(m1, 'master-20260918-210000-000.wav'),
    join(m1, 'Alice-20260918-210001-000.ogg'),
    join(m1, 'transcript-20260918-210500-000.md'),
    join(m2, 'master-20260918-220000-000.ogg'),
  ];
  for (const f of artifacts) writeFileSync(f, 'artifact');
  const temps = [
    join(m1, `master-20260918-210000-000${MIX_TMP_SUFFIX}`),
    join(m2, `master-20260918-220000-000${MIX_TMP_SUFFIX}`),
  ];
  for (const f of temps) writeFileSync(f, 'residue');
  return { m1, m2, artifacts, temps };
}

describe('sweepStaleMixTemps', () => {
  it('deletes every stale *.mix.tmp under the tree and logs each removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-sweep-'));
    try {
      const { temps } = plantTree(root);
      const logged = [];
      const removed = sweepStaleMixTemps(root, { log: (m) => logged.push(String(m)) });

      assert.equal(removed, temps.length, 'reports the removal count');
      for (const f of temps) assert.equal(existsSync(f), false, `removed ${f}`);
      assert.equal(logged.length, temps.length, 'one log line per removal');
      for (const f of temps) {
        assert.ok(
          logged.some((l) => l.includes(f)),
          `logged the removed path: ${f}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never touches a finished recording', () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-sweep-keep-'));
    try {
      const { artifacts } = plantTree(root);
      sweepStaleMixTemps(root, { log: () => {} });
      for (const f of artifacts) {
        assert.ok(existsSync(f), `kept the finished artifact ${f}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op on a missing root', () => {
    const missing = join(tmpdir(), 'dmr-sweep-does-not-exist-12345');
    assert.equal(sweepStaleMixTemps(missing, { log: () => {} }), 0);
  });

  it('bounds the walk to the given root (nothing outside is touched)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dmr-sweep-bound-'));
    try {
      const inner = join(parent, 'root');
      mkdirSync(inner, { recursive: true });
      const outside = join(parent, `master-1${MIX_TMP_SUFFIX}`);
      writeFileSync(outside, 'outside');
      sweepStaleMixTemps(inner, { log: () => {} });
      assert.ok(existsSync(outside), 'a sibling of the root is left alone');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('also removes a stale *.transcribe.tmp.wav, logged once, leaving finished files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-sweep-tx-'));
    try {
      const { m1, artifacts, temps } = plantTree(root);
      const tx = join(m1, `Alice-20260918-210001-000${TRANSCRIBE_TMP_SUFFIX}`);
      writeFileSync(tx, 'residue');
      const logged = [];
      const removed = sweepStaleMixTemps(root, { log: (m) => logged.push(String(m)) });
      assert.equal(TRANSCRIBE_TMP_SUFFIX, '.transcribe.tmp.wav');
      assert.equal(removed, temps.length + 1);
      assert.equal(existsSync(tx), false);
      assert.equal(logged.filter((l) => l.includes(tx)).length, 1);
      assert.ok(logged.every((l) => l.startsWith('removed stale temp ')));
      for (const f of artifacts) assert.ok(existsSync(f), `kept ${f}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
