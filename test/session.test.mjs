import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sessionDir,
  sessionUserFile,
  sessionMasterFile,
  sessionTimelineFile,
  fileTimestamp,
} from '../src/session.js';

describe('session layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-session-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sessionDir nests under the guild id and creates the directory', () => {
    const startedAt = new Date('2026-09-22T01:02:03Z');
    const guildId = '123456789012345678';
    const dir = sessionDir(root, startedAt, guildId);
    assert.equal(
      dir,
      join(root, 'discord-meetings', guildId, 'meeting-2026-09-22-01-02-03'),
    );
    assert.ok(dir.endsWith(join(guildId, 'meeting-2026-09-22-01-02-03')));
    assert.ok(existsSync(dir));
  });

  it('sessionDir without a guild id throws (legacy two-argument call)', () => {
    assert.throws(
      () => sessionDir(root, new Date('2026-09-22T01:02:03Z')),
      /Invalid guild id for the session directory: undefined/,
    );
  });

  it('sessionDir accepts the 17- and 20-digit snowflake boundaries', () => {
    const startedAt = new Date('2026-09-22T01:02:03Z');
    const seventeen = '1'.repeat(17);
    const twenty = '9'.repeat(20);
    const dir17 = sessionDir(
      mkdtempSync(join(tmpdir(), 'dmr-session-17-')),
      startedAt,
      seventeen,
    );
    const dir20 = sessionDir(
      mkdtempSync(join(tmpdir(), 'dmr-session-20-')),
      startedAt,
      twenty,
    );
    assert.ok(dir17.endsWith(join(seventeen, 'meeting-2026-09-22-01-02-03')));
    assert.ok(dir20.endsWith(join(twenty, 'meeting-2026-09-22-01-02-03')));
    assert.ok(existsSync(dir17));
    assert.ok(existsSync(dir20));
  });

  it('sessionDir rejects non-snowflake guild ids, naming the offending value', () => {
    const startedAt = new Date('2026-09-22T01:02:03Z');
    for (const bad of ['abc', '123', '123456789012345678901']) {
      assert.throws(
        () => sessionDir(root, startedAt, bad),
        (err) => {
          assert.match(err.message, /^Invalid guild id for the session directory: /);
          assert.ok(
            err.message.includes(String(bad)),
            `message names the offending value ${JSON.stringify(bad)}: ${err.message}`,
          );
          return true;
        },
      );
    }
    // '' is a literal case: `''.includes('')` is always true, so the substring
    // check above would be vacuous for it — assert the exact message instead.
    assert.throws(
      () => sessionDir(root, startedAt, ''),
      (err) => {
        assert.equal(
          err.message,
          'Invalid guild id for the session directory: ',
        );
        return true;
      },
    );
  });

  it('fileTimestamp is compact UTC', () => {
    assert.equal(
      fileTimestamp(new Date('2026-09-18T21:04:33.045Z')),
      '20260918-210433-045',
    );
  });

  it('sessionUserFile is sanitizedName-timestamp.ogg', () => {
    const dir = join(root, 'discord-meetings', 'meeting-x');
    const at = new Date('2026-09-18T21:04:33.045Z');
    const file = sessionUserFile(dir, 'Marcus/Adam', '999888777666', at);
    assert.equal(file, join(dir, 'Marcus_Adam-20260918-210433-045.ogg'));
  });

  it('sessionMasterFile is master-timestamp.ogg', () => {
    const dir = join(root, 'discord-meetings', 'meeting-x');
    const at = new Date('2026-09-18T21:04:33.045Z');
    assert.equal(
      sessionMasterFile(dir, at),
      join(dir, 'master-20260918-210433-045.ogg'),
    );
  });

  it('sessionTimelineFile is timeline-timestamp.jsonl, beside the master for the same instant', () => {
    const dir = join(root, 'discord-meetings', 'meeting-x');
    const at = new Date('2026-09-18T21:04:33.045Z');
    assert.equal(sessionTimelineFile(dir, at), join(dir, 'timeline-20260918-210433-045.jsonl'));
    assert.equal(
      basename(sessionTimelineFile(dir, at)).replace('timeline-', '').replace('.jsonl', ''),
      basename(sessionMasterFile(dir, at)).replace('master-', '').replace('.ogg', ''),
    );
  });
});
