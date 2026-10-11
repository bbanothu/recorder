import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sessionDir, sessionUserFile, sessionTimelineFile } from './session.js';
import { muxOpusToOgg } from './ogg-mux.js';
import { logEvent } from './log.js';
import { gapFrames } from './timeline-pad.js';
import { defaultSilenceFrame } from './opus-silence.js';
import pkg from '../package.json' with { type: 'json' };
import {
  appendTimelineEvent,
  sessionEvent,
  trackEvent,
  speechEvent,
  lifecycleEvent,
  endEvent,
} from './timeline.js';

/**
 * Per-speaker receive + per-user `.ogg` files.
 * The controller always passes `writePerUserFiles: true` (v3.0.0: every session
 * keeps its per-user tracks AND records master audio); the option itself stays
 * as a test/injection seam, so `writePerUserFiles: false` still writes nothing
 * per user.
 */
export class Recorder {
  /**
   * @param {{
   *   meetingsRoot: string,
   *   botUserId: string,
   *   guildId: string,
   *   startedAt?: Date,
   *   mux?: (packets: Buffer[], opts?: object) => Buffer,
   *   subscribe: (userId: string) => import('node:stream').Readable,
   *   now?: () => Date,
   *   onPacket?: (userId: string, packet: Buffer) => void,
   *   writePerUserFiles?: boolean,
   *   silenceFrame?: Buffer,
   * }} opts
   */
  constructor(opts) {
    this.meetingsRoot = opts.meetingsRoot;
    this.botUserId = opts.botUserId;
    this.guildId = opts.guildId;
    this.startedAt = opts.startedAt ?? new Date();
    this.mux = opts.mux ?? muxOpusToOgg;
    this.subscribe = opts.subscribe;
    this.now = opts.now ?? (() => new Date());
    this.onPacket = opts.onPacket;
    this.writePerUserFiles = opts.writePerUserFiles !== false;
    /** Shared libopus silence frame; lazily the memoized default. */
    this.silenceFrame = opts.silenceFrame ?? null;
    /** @type {string | null} */
    this.dir = null;
    /** @type {Map<string, {
     *   displayName: string,
     *   frames: Buffer[],
     *   stream: import('node:stream').Readable,
     *   path: string | null,
     *   onData: Function,
     *   announced: boolean, // informational: the speaking gate's verdict gates nothing
     *   startedAtMs: number,
     * }>} */
    this.users = new Map();
    /** @type {string[]} */
    this.files = [];
    /** @type {{path: string, displayName: string, startedAtMs: number, frames: number, speechFrames: number}[]} */
    this.userFiles = [];
    /** @type {number | null} */
    this.startedAtMs = null;
    /** @type {string | null} timeline-<stamp>.jsonl, named from startedAtMs */
    this.timelinePath = null;
    /** User ids seen this session (drives leave / reconnect). */
    this.seen = new Set();
    this.timelineFailed = false;
  }

  /** Append one timeline event; a failure logs once and never throws. */
  #timeline(event) {
    const path = this.timelinePath;
    if (!path) return;
    appendTimelineEvent(path, event, (err) => {
      if (this.timelineFailed) return;
      this.timelineFailed = true;
      logEvent(`timeline write failed for ${path} (${err?.message ?? err})`);
    });
  }

  start() {
    this.dir = sessionDir(this.meetingsRoot, this.startedAt, this.guildId);
    this.startedAtMs = this.now().getTime();
    this.users.clear();
    this.files = [];
    this.userFiles = [];
    this.seen = new Set();
    this.timelineFailed = false;
    // startedAtMs is the recorder's single session-zero clock read (Decision 7):
    // surfaced here so bot.js feeds this exact value to master.start() instead
    // of re-deriving it from a second clock read.
    // The timeline is named from that same read (never a second clock read).
    this.timelinePath = this.writePerUserFiles
      ? sessionTimelineFile(this.dir, new Date(this.startedAtMs))
      : null;
    this.#timeline(
      sessionEvent({
        t0: this.startedAtMs,
        guildId: this.guildId,
        botUserId: this.botUserId,
        dir: this.dir,
        version: pkg.version,
      }),
    );
    return {
      dir: this.dir,
      startedAtMs: this.startedAtMs,
      timelinePath: this.timelinePath,
    };
  }

  /**
   * @param {{ id: string, displayName: string }} user
   */
  addUser(user) {
    if (!this.dir) throw new Error('Recorder not started');
    if (user.id === this.botUserId) return;
    const existing = this.users.get(user.id);
    if (existing) {
      if (!existing.dead) return;
      // v3.0.2 D7: the stream died. Finalise (write, never drop) what it
      // captured; the fresh subscription below writes a NEW file.
      this.#finalize(user.id);
    }

    const at = this.now();
    const path = this.writePerUserFiles
      ? sessionUserFile(this.dir, user.displayName, user.id, at)
      : null;

    const stream = this.subscribe(user.id);
    // Lifecycle: `reconnect` for an id already seen this session. First
    // appearances emit no `join`: the `track` event marks them (builder exists).
    if (this.seen.has(user.id)) {
      this.#timeline(lifecycleEvent('reconnect', { userId: user.id, t: at.getTime() }));
    }
    this.seen.add(user.id);
    if (path) {
      this.#timeline(
        trackEvent({
          userId: user.id,
          displayName: user.displayName,
          file: basename(path),
          t: at.getTime(),
          t0: this.startedAtMs,
        }),
      );
    }
    /** @type {Buffer[]} */
    const frames = [];
    /** First hook failure is logged; later ones stay silent (per-packet spam). */
    let hookFailed = false;
    const entry = {
      displayName: user.displayName,
      frames,
      stream,
      path,
      onData: null,
      announced: false,
      startedAtMs: at.getTime(),
      droppedFrames: 0,
      speechFrames: 0,
      padFrames: 0,
      lastAtMs: at.getTime(),
      dead: false,
      onError: null,
      onClose: null,
    };
    const onData = (packet) => {
      const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
      // The packet hook is a CONSUMER (master mix push / speaking gate): a
      // throw inside it must never escape into the voice stream's 'data'
      // callback and kill the session. The per-user track is the product —
      // log the first failure loudly, keep recording (a throw means keep).
      // An explicit `false` is the decoder's verdict (v3.0.2 D2): the packet
      // is not audio, so it never enters the track.
      let keep = true;
      try {
        keep = this.onPacket?.(user.id, buf) !== false;
      } catch (err) {
        if (!hookFailed) {
          hookFailed = true;
          logEvent(
            `packet hook failed for ${user.id} (${err?.message ?? err}); per-user track keeps recording`,
          );
        }
      }
      if (!this.writePerUserFiles) return;
      if (!keep) {
        entry.droppedFrames += 1;
        return;
      }
      // v3.0.2 D1: fill the gap since the previous accepted packet with the
      // shared silence frame (one Buffer reference) so the track keeps the
      // meeting timeline. A clock failure must not lose the packet.
      try {
        const atMs = this.now().getTime();
        const n = gapFrames({ prevAtMs: entry.lastAtMs, atMs });
        if (n > 0) {
          const sil = (this.silenceFrame ??= defaultSilenceFrame());
          for (let i = 0; i < n; i++) frames.push(sil);
          entry.padFrames += n;
        }
        // Burst start: the first accepted packet, or the first after a gap.
        if (entry.speechFrames === 0 || n > 0) {
          this.#timeline(
            speechEvent({ userId: user.id, t: atMs, trackMs: frames.length * 20 }),
          );
        }
        entry.lastAtMs = atMs;
      } catch (err) {
        logEvent(`gap padding failed for ${user.id} (${err?.message ?? err})`);
      }
      frames.push(buf);
      entry.speechFrames += 1;
    };
    entry.onData = onData;
    stream.on('data', onData);

    // A dead stream (@discordjs/voice destroys it with an error on any
    // parse/decrypt throw) must neither crash the process via an unhandled
    // 'error' nor stay silent: mark it dead, log once, re-subscribe on the
    // speaker's next addUser. These handlers never throw.
    const markDead = (why) => {
      if (entry.dead) return;
      entry.dead = true;
      try {
        logEvent(
          `${entry.displayName}'s audio stream ended (${why}); will re-subscribe if they speak again`,
        );
      } catch {
        /* logging must never throw out of a stream listener */
      }
    };
    entry.onError = (err) => markDead(`error: ${err?.message ?? err}`);
    entry.onClose = () => markDead('closed');
    stream.on?.('error', entry.onError);
    stream.on?.('close', entry.onClose);

    this.users.set(user.id, entry);
  }

  /**
   * Log-only (v3.0.2 D3): SpeakingGate confirmed sustained speech. This never
   * decides whether a track is kept - `#finalize` keeps every track that holds
   * audio - it only announces the file once.
   */
  markConfirmed(userId) {
    const entry = this.users.get(userId);
    if (!entry || entry.announced) return;
    entry.announced = true;
    if (!this.writePerUserFiles || !entry.path) return;
    logEvent(
      `${entry.displayName} recording track opened → ${basename(entry.path)}`,
    );
  }

  /** @param {string} userId */
  removeUser(userId) {
    this.#finalize(userId);
  }

  stop() {
    for (const userId of [...this.users.keys()]) {
      this.#finalize(userId);
    }
    const dir = this.dir;
    const timelinePath = this.timelinePath;
    if (timelinePath && dir) {
      try {
        const t = this.now().getTime();
        this.#timeline(endEvent({ t, t0: this.startedAtMs, durationMs: t - this.startedAtMs }));
      } catch (err) {
        logEvent(`timeline end failed (${err?.message ?? err})`);
      }
    }
    const files = [...this.files];
    const userFiles = [...this.userFiles];
    this.dir = null;
    return { dir, files, userFiles, startedAtMs: this.startedAtMs, timelinePath };
  }

  /** @param {string} userId */
  #finalize(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    this.users.delete(userId);

    if (this.timelinePath && this.seen.has(userId)) {
      try {
        this.#timeline(lifecycleEvent('leave', { userId, t: this.now().getTime() }));
      } catch (err) {
        logEvent(`timeline leave failed for ${userId} (${err?.message ?? err})`);
      }
    }

    entry.stream.off?.('data', entry.onData);
    // Our own destroy() below must not read as a stream death; keep a no-op
    // 'error' listener so a late error on the destroyed stream is never unhandled.
    entry.stream.off?.('close', entry.onClose);
    entry.stream.off?.('error', entry.onError);
    entry.stream.on?.('error', () => {});
    if (typeof entry.stream.destroy === 'function') {
      entry.stream.destroy();
    }

    if (!this.writePerUserFiles || !entry.path) return;

    if (entry.frames.length === 0) {
      if (entry.droppedFrames > 0) {
        logEvent(
          `${entry.displayName} recording skipped (no decodable audio — ${entry.droppedFrames} packets dropped)`,
        );
      }
      return;
    }

    const buf = this.mux(entry.frames, {
      channels: 2,
      sampleRate: 48000,
      samplesPerFrame: 960,
    });
    writeFileSync(entry.path, buf);
    this.files.push(entry.path);
    this.userFiles.push({
      path: entry.path,
      displayName: entry.displayName,
      startedAtMs: entry.startedAtMs,
      frames: entry.frames.length,
      speechFrames: entry.speechFrames,
      dropped: entry.droppedFrames,
    });
    logEvent(
      `${entry.displayName} recording file created → ${basename(entry.path)} (${entry.frames.length} frames)` +
        (entry.droppedFrames > 0
          ? `, ${entry.droppedFrames} undecodable packet(s) dropped`
          : ''),
    );
  }
}
