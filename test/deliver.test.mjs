import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deliverSession, MAX_UPLOAD_BYTES } from '../src/deliver.js';

function mockInteraction() {
  const replies = [];
  return {
    user: {
      id: 'inv1',
      async send(payload) {
        if (this._forbid) {
          const err = new Error('Cannot send messages to this user');
          err.code = 50007;
          throw err;
        }
        this._dms.push(payload);
        return payload;
      },
      _forbid: false,
      _dms: [],
    },
    async editReply(payload) {
      replies.push(payload);
      return payload;
    },
    _replies: replies,
  };
}

const text = (r) => (typeof r === 'string' ? r : String(r?.content ?? ''));

describe('deliverSession', () => {
  const root = mkdtempSync(join(tmpdir(), 'dmr-del-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A session dir with n per-user tracks + an optional master mix file. */
  function fixture(name, { tracks = 3, master = 'master-test.ogg' } = {}) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const userFiles = [];
    for (let i = 0; i < tracks; i++) {
      const p = join(dir, `Speaker${i}-u${i}.ogg`);
      writeFileSync(p, Buffer.alloc(100, i + 1));
      userFiles.push(p);
    }
    const masterFile = master ? join(dir, master) : null;
    if (masterFile) writeFileSync(masterFile, Buffer.alloc(200, 9));
    return { dir, userFiles, masterFile };
  }

  it('nothing captured (no tracks, no master) → nobody spoke, no upload', async () => {
    const interaction = mockInteraction();
    const dir = join(root, 'empty');
    mkdirSync(dir, { recursive: true });
    const result = await deliverSession({ masterHadAudio: false, interaction, dir, userFiles: [], masterFile: null });
    assert.deepEqual(result, { delivered: false });
    assert.match(text(interaction._replies[0]), /nobody spoke/i);
    assert.equal(interaction.user._dms.length, 0);
  });

  it('master .ogg under cap with tracks present → exactly ONE DM, the master mix', async () => {
    const { dir, userFiles, masterFile } = fixture('master-happy');
    const before = readdirSync(dir).sort();
    const interaction = mockInteraction();
    const result = await deliverSession({
      masterHadAudio: false,
      interaction,
      dir,
      userFiles,
      masterFile,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
    assert.deepEqual(result, { delivered: true });
    // exactly one send, and its content names the master mix
    assert.equal(interaction.user._dms.length, 1);
    const dm = interaction.user._dms[0];
    assert.equal(dm.content, 'Your meeting recording (master mix):');
    assert.deepEqual(dm.files, [masterFile]);
    assert.equal(
      text(interaction._replies.at(-1)),
      'Stopped. Sent the master mix to your DMs.',
    );

    // NEGATIVE PIN — "never DM the tracks" is this task's whole point.
    // 1. every path handed to the sender is the master, nothing else.
    for (const sent of interaction.user._dms) {
      for (const p of sent.files) assert.equal(p, masterFile, `${p} is not the master mix`);
      assert.equal(sent.files.length, 1);
    }
    // 2. no track path ever reached a payload (belt and braces).
    const sentPaths = interaction.user._dms.flatMap((d) => d.files);
    for (const t of userFiles) assert.ok(!sentPaths.includes(t), `track ${t} was sent`);
    // 3. nothing else was written to disk — delivery builds no artifact at all
    // (the tracks-archive zip this used to guard cannot be produced any more).
    assert.deepEqual(readdirSync(dir).sort(), before, 'delivery writes nothing to the session dir');
  });

  it('master-only session (no tracks) still delivers the master — never "nobody spoke"', async () => {
    const { dir, masterFile } = fixture('master-only', { tracks: 0 });
    const interaction = mockInteraction();
    const result = await deliverSession({ masterHadAudio: false, interaction, dir, userFiles: [], masterFile });
    assert.deepEqual(result, { delivered: true });
    assert.equal(interaction.user._dms.length, 1);
    assert.deepEqual(interaction.user._dms[0].files, [masterFile]);
    assert.doesNotMatch(text(interaction._replies.at(-1)), /nobody spoke/i);
  });

  it('master .wav (ffmpeg fallback) → not sent, path reply', async () => {
    const { dir, userFiles, masterFile } = fixture('master-wav', { master: 'master-test.wav' });
    const interaction = mockInteraction();
    const result = await deliverSession({ masterHadAudio: false, interaction, dir, userFiles, masterFile });
    assert.deepEqual(result, { delivered: false });
    assert.equal(interaction.user._dms.length, 0);
    assert.match(
      text(interaction._replies.at(-1)),
      /The master mix was kept as \.wav \(ffmpeg unavailable\) and was not sent\./,
    );
    assert.ok(text(interaction._replies.at(-1)).includes(dir));
  });

  it('oversize master → not sent, path reply', async () => {
    const { dir, userFiles, masterFile } = fixture('master-big');
    const interaction = mockInteraction();
    const result = await deliverSession({
      masterHadAudio: false,
      interaction,
      dir,
      userFiles,
      masterFile,
      maxUploadBytes: 10, // force oversize
    });
    assert.deepEqual(result, { delivered: false });
    assert.equal(interaction.user._dms.length, 0);
    assert.match(
      text(interaction._replies.at(-1)),
      /The master mix is too large for Discord and stays on disk\./,
    );
    assert.ok(text(interaction._replies.at(-1)).includes(dir));
  });

  it('forbidden master DM (50007) → path reply, never a second send', async () => {
    const { dir, userFiles, masterFile } = fixture('master-forbid');
    const interaction = mockInteraction();
    interaction.user._forbid = true;
    const result = await deliverSession({ masterHadAudio: false, interaction, dir, userFiles, masterFile });
    assert.deepEqual(result, { delivered: false });
    assert.equal(interaction.user._dms.length, 0);
    const reply = text(interaction._replies.at(-1));
    assert.match(reply, /Could not DM the master mix\. Files are at:/);
    assert.ok(reply.includes(dir));
  });

  it('a failed master write (masterFile null) with tracks present → nothing sent, never a second send', async () => {
    const { dir, userFiles } = fixture('master-failed');
    const interaction = mockInteraction();
    const result = await deliverSession({ masterHadAudio: false, interaction, dir, userFiles, masterFile: null });
    assert.deepEqual(result, { delivered: false });
    assert.equal(interaction.user._dms.length, 0);
    assert.match(text(interaction._replies.at(-1)), /The master mix could not be written — see the log\./);
    assert.ok(text(interaction._replies.at(-1)).includes(dir));
  });

  it('a FAILED master write after audio was heard (masterHadAudio) → "could not be written", never "nobody spoke"', async () => {
    // The reachable split-brain combination: the mix DID hear audio (packetCount
    // > 0) but the master write failed, and no per-user track was confirmed
    // (speech shorter than the confirm window) — so the caller reaches rule (1)
    // with userFiles: [] and masterFile: null. "Nobody spoke" would contradict
    // the bot's stop tail ("The master mix could not be written"), which is
    // exactly the drift this case pins.
    const dir = join(root, 'master-failed-audio');
    mkdirSync(dir, { recursive: true });
    const interaction = mockInteraction();
    const result = await deliverSession({
      interaction,
      dir,
      userFiles: [],
      masterFile: null,
      masterHadAudio: true,
    });
    assert.deepEqual(result, { delivered: false });
    assert.equal(interaction.user._dms.length, 0);
    const reply = text(interaction._replies[0]);
    assert.match(reply, /The master mix could not be written — see the log\./);
    assert.ok(reply.includes(dir), 'the reply names the on-disk path');
    assert.doesNotMatch(reply, /nobody spoke/i);
  });

  it('sendAudio: false → zero sends, files kept reply, suppressed', async () => {
    const { dir, userFiles, masterFile } = fixture('audio-off');
    const before = readdirSync(dir).sort();
    const interaction = mockInteraction();
    const result = await deliverSession({
      masterHadAudio: false,
      interaction,
      dir,
      userFiles,
      masterFile,
      sendAudio: false,
    });
    assert.deepEqual(result, { delivered: false, suppressed: true });
    assert.equal(interaction.user._dms.length, 0);
    const reply = text(interaction._replies.at(-1));
    assert.match(reply, /Audio DMs are off \(\/dm audio TRUE to re-enable\)\. Files are at:/);
    assert.ok(reply.includes(dir));
    // nothing written to disk: no new files at all
    assert.deepEqual(readdirSync(dir).sort(), before);
  });

  it('sendAudio: false with nothing captured → nobody spoke, not suppressed', async () => {
    const interaction = mockInteraction();
    const dir = join(root, 'audio-off-empty');
    mkdirSync(dir, { recursive: true });
    const result = await deliverSession({
      masterHadAudio: false,
      interaction,
      dir,
      userFiles: [],
      masterFile: null,
      sendAudio: false,
    });
    assert.deepEqual(result, { delivered: false });
    assert.match(text(interaction._replies[0]), /nobody spoke/i);
    assert.equal(interaction.user._dms.length, 0);
  });

  it('auto mode: no interaction, DMs via dmInvoker, notify gets the log line', async () => {
    const { dir, userFiles, masterFile } = fixture('auto-happy');
    const dms = [];
    const notified = [];
    const result = await deliverSession({
      masterHadAudio: false,
      dir,
      userFiles,
      masterFile,
      invokerId: 'inv1',
      auto: true,
      notify: (t) => notified.push(t),
      dmInvoker: async (id, payload) => dms.push({ id, payload }),
    });
    assert.deepEqual(result, { delivered: true });
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, 'inv1');
    assert.deepEqual(dms[0].payload.files, [masterFile]);
    assert.equal(notified.length, 1);
    assert.match(notified[0], /Auto-stopped\. Sent the master mix to your DMs\./);
  });

  it('auto mode: closed DMs (50007) → notify logs the master path message', async () => {
    const { dir, userFiles, masterFile } = fixture('auto-forbid');
    const notified = [];
    const result = await deliverSession({
      masterHadAudio: false,
      dir,
      userFiles,
      masterFile,
      invokerId: 'inv1',
      auto: true,
      notify: (t) => notified.push(t),
      dmInvoker: async () => {
        const err = new Error('Cannot send messages to this user');
        err.code = 50007;
        throw err;
      },
    });
    assert.deepEqual(result, { delivered: false });
    assert.equal(notified.length, 1);
    assert.match(notified[0], /Auto-stopped\. Could not DM the master mix\./);
    assert.match(notified[0], new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('a non-forbidden send error still propagates (delivery failures are not swallowed)', async () => {
    const { dir, userFiles, masterFile } = fixture('auto-boom');
    await assert.rejects(
      () =>
        deliverSession({
      masterHadAudio: false,
          dir,
          userFiles,
          masterFile,
          invokerId: 'inv1',
          auto: true,
          notify: () => {},
          dmInvoker: async () => {
            throw new Error('gateway exploded');
          },
        }),
      /gateway exploded/,
    );
  });
  it('required-argument guard: a non-boolean masterHadAudio or a missing dir throws', async () => {
    const { dir, masterFile } = fixture('guard');
    const interaction = mockInteraction();
    // null / 0 / missing must all throw — an undefined-only check let null and
    // 0 slip through and silently reproduce the nothing-captured bug.
    for (const bad of [undefined, null, 0, 'false']) {
      await assert.rejects(
        () => deliverSession({ masterHadAudio: bad, interaction, dir, userFiles: [], masterFile }),
        /masterHadAudio must be a boolean/,
      );
    }
    await assert.rejects(
      () => deliverSession({ masterHadAudio: true, interaction, dir: '', userFiles: [], masterFile }),
      /dir is required/,
    );
    // A valid boolean still passes the guard (and delivers the master).
    const ok = await deliverSession({ masterHadAudio: true, interaction, dir, userFiles: [], masterFile });
    assert.deepEqual(ok, { delivered: true });
  });

});
