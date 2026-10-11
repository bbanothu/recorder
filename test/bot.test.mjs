import { describe, it, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createSessionController, createCommandDeployer, commandData, buildHelpText } from '../src/bot.js';
import { deliverSession } from '../src/deliver.js';
import { createMapConfigStore, createConfigStore } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { Recorder } from '../src/recorder.js';
import { MasterMix } from '../src/master-mix.js';
import { SPEAKING_DEFAULTS } from '../src/speaking-gate.js';
import OpusScript from 'opusscript';
import { setImmediate, clearImmediate } from 'node:timers';
import { join } from 'node:path';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function mockInteraction(overrides = {}) {
  const replies = [];
  return {
    guildId: 'g1',
    user: { id: 'invoker1' },
    member: {
      voice: { channel: overrides.noVc ? null : { id: 'vc1', name: 'General', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } } },
      displayName: 'Invoker',
    },
    guild: {
      id: 'g1',
      members: {
        cache: new Map([
          ['u1', { displayName: 'Alice' }],
          ['u2', { displayName: 'Bob' }],
        ]),
      },
      voiceAdapterCreator: () => ({}),
    },
    replied: false,
    deferred: false,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
      return payload;
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      replies.push(payload);
      return payload;
    },
    async followUp(payload) {
      replies.push(payload);
      return payload;
    },
    _replies: replies,
    ...overrides,
  };
}

/**
 * v3.0.1 Task 2: /stop now replies the ack IMMEDIATELY and runs the stop
 * pipeline in the background, so `await controller.stop(i)` no longer implies
 * "the pipeline finished". Drain the microtask/immediate queue before asserting
 * on anything the pipeline produces (delivery, notices, the outcome edit).
 */
async function flushBackground(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

describe('session controller /record /stop', () => {
  let controller;
  let destroyed;
  let deliverCalls;
  let recorderInstances;

  beforeEach(() => {
    destroyed = false;
    deliverCalls = [];
    recorderInstances = [];

    controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        joinConfig: { channelId: 'vc1' },
        destroy() {
          destroyed = true;
        },
      }),
      createRecorder: (opts) => {
        const rec = {
          opts,
          started: false,
          stopped: false,
          dir: 'C:\\meetings\\discord-meetings\\meeting-test',
          start() {
            this.started = true;
            return { dir: this.dir };
          },
          addUser() {},
          removeUser() {},
          stop() {
            this.stopped = true;
            return { dir: this.dir, files: ['a.ogg'] };
          },
        };
        recorderInstances.push(rec);
        return rec;
      },
      deliver: async (args) => {
        deliverCalls.push(args);
      },
    });
  });

  it('/record when already recording → ephemeral error', async () => {
    const i1 = mockInteraction();
    await controller.record(i1);
    const i2 = mockInteraction();
    await controller.record(i2);
    assert.match(JSON.stringify(i2._replies[0]), /already recording/i);
  });

  it('/record with no VC → join a voice channel first', async () => {
    const i = mockInteraction({ noVc: true });
    await controller.record(i);
    assert.match(JSON.stringify(i._replies[0]), /voice channel/i);
  });

  it('/record happy path starts recorder', async () => {
    const i = mockInteraction();
    await controller.record(i);
    assert.equal(recorderInstances[0].started, true);
    assert.ok(controller.isRecording());
    assert.match(JSON.stringify(i._replies.at(-1)), /recording/i);
  });

  it('/stop when idle → nothing recording', async () => {
    const i = mockInteraction();
    await controller.stop(i);
    assert.match(JSON.stringify(i._replies[0]), /nothing recording/i);
  });

  it('/stop stops, disconnects, delivers, clears', async () => {
    await controller.record(mockInteraction());
    const i = mockInteraction();
    await controller.stop(i);
    await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack
    assert.equal(recorderInstances[0].stopped, true);
    assert.equal(destroyed, true);
    assert.equal(deliverCalls.length, 1);
    assert.equal(controller.isRecording(), false);
  });

  it('session records joinedAt/lastActivityAt/channel and debugSession exposes them', async () => {
    let clockMs = Date.UTC(2026, 8, 19, 12, 0, 0);
    // Mocks duplicated inline per plan (shared beforeEach mocks stay untouched);
    // same recorder factory so recorderInstances captures opts.onPacket.
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      // v3.0.0 Task 3: the master mix is built unconditionally now. This
      // test only drives activity packets through the recorder, so stub the
      // mix out (a real one would decode them against its own clock).
      createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
      now: () => new Date(clockMs),
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        joinConfig: { channelId: 'vc1' },
        destroy() {},
      }),
      createRecorder: (opts) => {
        const rec = {
          opts,
          started: false,
          stopped: false,
          dir: 'C:\\meetings\\discord-meetings\\meeting-test',
          start() {
            this.started = true;
            return { dir: this.dir };
          },
          addUser() {},
          removeUser() {},
          stop() {
            this.stopped = true;
            return { dir: this.dir, files: ['a.ogg'] };
          },
        };
        recorderInstances.push(rec);
        return rec;
      },
      deliver: async () => {},
    });
    await ctrl.record(mockInteraction());
    const s = ctrl.debugSession();
    assert.equal(s.joinedAt.getTime(), clockMs);
    assert.equal(s.lastActivityAt.getTime(), clockMs);
    assert.equal(s.channel.id, 'vc1');
    // qualifying packet advances the clock
    clockMs += 1_000;
    recorderInstances.at(-1).opts.onPacket('u1', Buffer.alloc(60));
    assert.equal(ctrl.debugSession().lastActivityAt.getTime(), clockMs);
    // comfort-noise packet does NOT
    clockMs += 1_000;
    recorderInstances.at(-1).opts.onPacket('u1', Buffer.alloc(8));
    assert.equal(ctrl.debugSession().lastActivityAt.getTime(), clockMs - 1_000);
  });
});

// --- master-mix failure isolation (v3.0.0: every session has a master) ---
// The master is now built unconditionally and finalize() runs on every stop,
// so a mix failure must never abort /stop or escape into a voice callback.

describe('master-mix failure isolation', () => {
  // A clock far from wall time: a mix reading its OWN Date.now() against this
  // session zero would compute ~a decade of 20ms frames → unbounded alloc.
  const OLD = Date.UTC(2000, 0, 1);
  const SNOWFLAKE = '123456789012345678';
  const VOICE = () => ({
    receiver: {
      speaking: { on() {} },
      subscribe: () => ({ on() {}, destroy() {} }),
      subscriptions: new Map(),
    },
    joinConfig: { channelId: 'vc1' },
    destroy() {},
  });

  it('a rejecting master.finalize() still delivers, notices, and destroys the connection', async () => {
    let destroyed = false;
    const deliverCalls = [];
    const notices = [];
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      now: () => new Date(OLD),
      createMasterMix: () => ({
        start() {},
        push() {},
        finalize: async () => {
          throw new Error('ENOSPC: no space left on device, write');
        },
      }),
      notifyChannel: async (_channelId, text) => {
        notices.push(text);
      },
      joinVoice: async () => {
        const c = VOICE();
        c.destroy = () => {
          destroyed = true;
        };
        return c;
      },
      createRecorder: () => ({
        start() {
          return { dir: 'C:\\meetings\\discord-meetings\\meeting-test' };
        },
        addUser() {},
        removeUser() {},
        stop() {
          return {
            dir: 'C:\\meetings\\discord-meetings\\meeting-test',
            files: ['a.ogg'],
            userFiles: [
              { path: 'a.ogg', displayName: 'Alice', startedAtMs: OLD, frames: 120, speechFrames: 120 },
            ],
          };
        },
      }),
      deliver: async (args) => {
        deliverCalls.push(args);
      },
    });

    const i = mockInteraction();
    await ctrl.record(i);
    await ctrl.stop(i);
    await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack

    assert.equal(destroyed, true, 'connection destroyed despite the master failure');
    assert.equal(deliverCalls.length, 1, 'delivery still ran');
    assert.deepEqual(deliverCalls[0].userFiles.map((f) => f.path), ['a.ogg']);
    assert.equal(deliverCalls[0].masterFile, null, 'the failed master is not a payload');
    assert.ok(
      notices.some((n) => /Recording stopped\./.test(n)),
      `channel notice still posted: ${notices.join(' | ')}`,
    );
    assert.equal(ctrl.isRecording(), false);
  });

  it('a throwing packet hook (master push) never escapes the voice data callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-bot-mix-'));
    const stream = new EventEmitter();
    /** @type {Function | undefined} */
    let speakingStart;
    try {
      const ctrl = createSessionController({
        botUserId: 'bot1',
        meetingsRoot: root,
        now: () => new Date(OLD),
        createMasterMix: () => ({
          start() {},
          push() {
            throw new Error('master mix allocation failed');
          },
          finalize: async () => null,
        }),
        joinVoice: async () => ({
          receiver: {
            speaking: {
              on(evt, fn) {
                if (evt === 'start') speakingStart = fn;
              },
            },
            subscribe: () => stream,
            subscriptions: new Map(),
          },
          joinConfig: { channelId: 'vc1' },
          destroy() {},
        }),
        // Real Recorder: the guard under test lives in its 'data' callback.
        createRecorder: (opts) => new Recorder({ ...opts, subscribe: () => stream }),
        deliver: async () => {},
        // Timer hygiene (Task 7b review): this case fires speakingStart and
        // never stops the session, so the gate would arm a REAL 1000 ms default
        // confirm timer and leave the process holding a live handle (and a
        // mutated-huge default would still pass). The fake pair arms nothing.
        gateTimers: fakeGateTimers(),
      });

      await ctrl.record(mockInteraction({ guildId: SNOWFLAKE }));
      assert.ok(speakingStart, 'speaking listener captured');
      speakingStart('u1'); // → recorder.addUser() → subscribe()

      assert.doesNotThrow(() => stream.emit('data', Buffer.alloc(60)));
      assert.equal(ctrl.isRecording(), true, 'session survives the hook failure');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('v3.0.2 D2: a packet the master mix rejects is absent from the track the bot produced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-bot-d2-'));
    const bad = Buffer.from(
      JSON.parse(readFileSync(new URL('./fixtures/undecodable-opus-packets.json', import.meta.url), 'utf8')).packets[0],
      'base64',
    );
    const stream = new EventEmitter();
    let speakingStart;
    let rec;
    let stopResult;
    let delivered;
    const deliveredP = new Promise((r) => (delivered = r));
    try {
      const ctrl = createSessionController({
        botUserId: 'bot1',
        meetingsRoot: root,
        now: () => new Date(OLD),
        transcribeEnabled: false,
        createMasterMix: () => ({
          start() {},
          push: (_id, pkt) => !pkt.equals(bad),
          finalize: async () => null,
        }),
        joinVoice: async () => ({
          receiver: {
            speaking: {
              on(evt, fn) {
                if (evt === 'start') speakingStart = fn;
              },
            },
            subscribe: () => stream,
            subscriptions: new Map(),
          },
          joinConfig: { channelId: 'vc1' },
          destroy() {},
        }),
        createRecorder: (opts) => {
          rec = new Recorder({ ...opts, subscribe: () => stream });
          const origStop = rec.stop.bind(rec);
          rec.stop = () => (stopResult = origStop());
          return rec;
        },
        deliver: async () => {
          delivered();
          return { delivered: true };
        },
        gateTimers: fakeGateTimers(),
      });
      await ctrl.record(mockInteraction({ guildId: SNOWFLAKE }));
      speakingStart('u1');
      rec.markConfirmed('u1');
      stream.emit('data', bad);
      stream.emit('data', Buffer.alloc(30, 0xfc));
      await ctrl.stop(mockInteraction({ guildId: SNOWFLAKE }));
      await deliveredP;
      assert.equal(stopResult.userFiles.length, 1);
      assert.equal(stopResult.userFiles[0].frames, 1, 'the rejected packet is not in the track');
      assert.equal(stopResult.userFiles[0].dropped, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards the injected clock into the real MasterMix (no two-clock drift)', async () => {
    let clockMs = OLD;
    /** @type {any} */
    let recOpts;
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      now: () => new Date(clockMs),
      // NO createMasterMix → the controller builds a REAL MasterMix.
      joinVoice: async () => VOICE(),
      createRecorder: (opts) => {
        recOpts = opts;
        return {
          start() {
            return { dir: 'C:\\meetings\\discord-meetings\\meeting-test' };
          },
          addUser() {},
          removeUser() {},
          stop() {
            return { dir: 'C:\\meetings\\discord-meetings\\meeting-test', files: [] };
          },
        };
      },
      deliver: async () => {},
    });

    await ctrl.record(mockInteraction());
    const master = ctrl.debugSession().master;
    clockMs += 5_000;
    assert.equal(master.now(), clockMs, 'mix timestamps come from the injected clock');

    // A real packet mixes against the same session zero. With two clocks the
    // elapsed gap was ~a decade of frames → RangeError: allocation failed.
    const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const pkt = Buffer.from(enc.encode(Buffer.alloc(960 * 2 * 2), 960));
    assert.doesNotThrow(() => recOpts.onPacket('u1', pkt));
    // The scratch is ONE packet's 20 ms stereo frame (1920 interleaved samples).
    // The old bound (1920 * 300) was satisfied by any small scratch — i.e.
    // vacuous after 3b — while this session spans 5 s = 250 frames, so a
    // session-length buffer would be ~250x the scratch.
    assert.ok(
      master.mix.length <= 1920,
      `scratch is packet-bounded (${master.mix.length} samples; a 20 ms stereo frame is 1920)`,
    );
  });

  it('the failed-write classification reads the REAL MasterMix#packetCount', async () => {
    // The bot's failed-write-vs-silence read is `master.packetCount` — a field
    // owned by the REAL MasterMix. Every other case here stubs the mix and
    // supplies its own `packetCount`, so a coordinated rename of the field plus
    // those stubs would leave the bot silently classifying a failed write as
    // silence. This case runs the production mix: one real Opus packet in, a
    // REAL disk failure at finalize (the session directory does not exist), and
    // the deliver call must still report "the mix heard audio".
    const root = mkdtempSync(join(tmpdir(), 'dmr-bot-realpk-'));
    const deliverCalls = [];
    const notices = [];
    /** @type {any} */
    let mix = null;
    try {
      const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      const packet = Buffer.from(enc.encode(Buffer.alloc(960 * 2 * 2), 960));
      const missingDir = join(root, 'session-dir-that-does-not-exist');

      const ctrl = createSessionController({
        botUserId: 'bot1',
        meetingsRoot: root,
        now: () => new Date(OLD),
        // REAL mix (real temp file, real accumulator). Its WAV write fails
        // before the ffmpeg pass, so nothing shells out. The injected clock
        // must be handed over here: the controller only wires `now` into the
        // mix it constructs itself, and a mix reading the wall clock against
        // this 2000-01-01 session zero would blow the frame offset out.
        createMasterMix: () => (mix = new MasterMix({ now: () => OLD })),
        joinVoice: async () => VOICE(),
        createRecorder: (recOpts) => ({
          start: () => ({ dir: root, startedAtMs: OLD }),
          addUser() {},
          removeUser() {},
          markConfirmed() {},
          // stop() hands back a directory that no longer exists -> the master
          // WAV cannot be written -> finalize() returns null with ioError clear.
          stop: () => ({ dir: missingDir, files: [], userFiles: [] }),
          packet: () => recOpts.onPacket('u1', packet),
        }),
        deliver: async (args) => {
          deliverCalls.push(args);
          return { delivered: true };
        },
        notifyChannel: async (_channelId, t) => notices.push(t),
      });

      await ctrl.record(mockInteraction());
      ctrl.debugSession().recorder.packet(); // one real Opus packet into the mix

      // The field the bot reads, on the real class, BEFORE finalize() resets it.
      assert.ok(mix instanceof MasterMix, 'the production mix is under test');
      assert.equal(mix.packetCount, 1, 'the real mix counted the packet the bot reads');

      await ctrl.stop(mockInteraction());
      await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack

      // A clean disk failure (ioError stays null), so the ONLY signal left is
      // the packetCount read the bot took before finalize().
      assert.equal(mix.ioError, null, 'a write failure, not an accumulator error');
      assert.equal(deliverCalls[0].masterFile, null, 'the master write failed');
      assert.equal(
        deliverCalls[0].masterHadAudio,
        true,
        'the bot classified the failed write as "heard audio", not silence',
      );
      assert.equal(
        mix.packetCount,
        0,
        "finalize() reset the real counter — so the bot's read must be a BEFORE-read",
      );
      assert.match(notices.at(-1), /The master mix could not be written — see the log\./);
      assert.doesNotMatch(notices.at(-1), /nobody spoke/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- auto-stop failsafe (fake clock; no real sleeps) ---

class FakeCollection extends Map {
  filter(fn) {
    return new FakeCollection([...this].filter(([, v]) => fn(v)));
  }
}

const humanMember = () => ({ user: { bot: false } });
const botMember = () => ({ user: { bot: true } });

const MIN = 60_000;

/**
 * One merged harness (plan NOTE: the draft helpers were folded together).
 * setIntervalFn captures the tick fn and returns handle 7; clearIntervalFn
 * records into `cleared`; `now` is a fake clock; the channel mock uses a
 * Map-backed FakeCollection with filter() (plain Map lacks it), so tests can
 * add/delete members to change the human count.
 */
function makeHarness(opts = {}) {
  let clockMs = Date.UTC(2026, 8, 19, 12, 0, 0);
  let tickFn = null;
  const cleared = [];
  const deliverCalls = [];
  const recorderInstances = [];
  const notifyCalls = [];
  // shared ordering trace: mocks append 'deliver' / 'notice' as they run
  const seq = [];
  // notifyChannel seam: `true` → recording mock; a function → pass through
  // as-is (failure scenarios); absent/undefined → NO notifyChannel dep at all.
  const notifyChannelDep =
    opts.notifyChannel === true
      ? async (channelId, text) => {
          notifyCalls.push({ channelId, text });
          seq.push(text.includes('started recording') ? 'start-notice' : 'notice');
        }
      : typeof opts.notifyChannel === 'function'
        ? opts.notifyChannel
        : undefined;

  const membersCollection = opts.membersMissing
    ? null
    : new FakeCollection([
        // the bot itself is always present in the cache and must not count as human
        ['bot1', botMember()],
        ...(opts.humans ?? [
          ['u1', humanMember()],
          ['u2', humanMember()],
        ]),
      ]);

  const channel = opts.membersMissing
    ? { id: 'vc1', name: 'G', guild: { id: 'g1' } } // no .members at all
    : { id: 'vc1', name: 'G', guild: { id: 'g1' }, members: membersCollection };

  function newInteraction() {
    return {
      guildId: 'g1',
      user: { id: 'invoker1' },
      member: { voice: { channel } },
      guild: {
        id: 'g1',
        members: { cache: new Map() },
        voiceAdapterCreator: () => ({}),
      },
      replied: false,
      deferred: false,
      _replies: [],
      async reply(p) {
        this.replied = true;
        this._replies.push(p);
        return p;
      },
      async deferReply() {
        this.deferred = true;
      },
      async editReply(p) {
        this._replies.push(p);
        return p;
      },
    };
  }
  const interaction = newInteraction();

  // 2.0.0 per-guild config: Map-backed store; legacy deps persist as seeds.
  const store = createMapConfigStore({
    transcribeEnabled: true,
    dmAudioEnabled: true,
    dmTranscribeEnabled: true,
    autostopMinutes: Math.round((opts.autoStopThresholdMs ?? 5 * MIN) / MIN),
  });

  const controller = createSessionController({
    botUserId: 'bot1',
    meetingsRoot: 'C:\\meetings',
    configStore: store,
    ...(opts.transcribeEnabled !== undefined
      ? { transcribeEnabled: opts.transcribeEnabled }
      : {}),
    now: () => new Date(clockMs),
    autoStopThresholdMs: opts.autoStopThresholdMs ?? 5 * MIN,
    setIntervalFn: (fn) => {
      tickFn = fn;
      return 7;
    },
    clearIntervalFn: (id) => {
      cleared.push(id);
    },
    joinVoice: opts.joinVoiceFails
      ? async () => {
          throw new Error('boom');
        }
      : async () => ({
          receiver: {
            speaking: { on() {} },
            subscribe: () => ({ on() {}, destroy() {} }),
            subscriptions: new Map(),
          },
          destroy() {},
        }),
    createRecorder: (recOpts) => {
      const rec = {
        opts: recOpts,
        start: () => ({ dir: 'C:\\meetings\\x' }),
        addUser() {},
        removeUser() {},
        stop: () => ({ dir: 'C:\\meetings\\x', files: opts.files ?? [] }),
      };
      recorderInstances.push(rec);
      return rec;
    },
    deliver: async (args) => {
      deliverCalls.push(args);
      seq.push('deliver');
      return { delivered: opts.deliverReturnsFalse ? false : true };
    },
    ...(notifyChannelDep !== undefined ? { notifyChannel: notifyChannelDep } : {}),
    // v3.0.0 Task 3: every session builds a master mix. These gluing suites keep
    // audio I/O out of the picture (a REAL MasterMix would decode the activity
    // packets they push and try to write a WAV beside the fake dir); the
    // always-BOTH master wiring itself is pinned by its own suite below.
    createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
    ...(opts.createMasterMix !== undefined
      ? { createMasterMix: opts.createMasterMix }
      : {}),
  });

  async function start() {
    await controller.record(interaction);
  }

  function advance(ms) {
    clockMs += ms;
  }

  /** Push a packet through the live recorder's captured onPacket callback. */
  function pushPacket(bytes) {
    recorderInstances.at(-1).opts.onPacket('u1', Buffer.alloc(bytes));
  }

  /**
   * Tick is fire-and-forget in bot.js (no await): flush pending immediates so
   * stopSession's awaited deliver has completed before assertions run.
   */
  async function fireTick() {
    if (typeof tickFn !== 'function') {
      throw new TypeError('tick is not a function: controller never used setIntervalFn');
    }
    tickFn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  return {
    controller,
    interaction,
    newInteraction,
    start,
    advance,
    fireTick,
    pushPacket,
    cleared,
    deliverCalls,
    notifyCalls,
    seq,
    recorderInstances,
    membersCollection,
    store,
    clock: () => clockMs,
  };
}

describe('auto-stop failsafe', () => {
  it('1. empty channel at 5 min → auto stopSession delivers, timer cleared', async () => {
    const h = makeHarness({ humans: [] });
    await h.start();
    h.advance(5 * MIN);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1);
    const call = h.deliverCalls[0];
    assert.equal(call.auto, true);
    assert.equal(call.interaction, null);
    assert.equal(typeof call.notify, 'function');
    assert.match(call.reason, /everyone left/);
    assert.ok(h.cleared.includes(7), 'interval handle 7 was cleared');
    assert.equal(h.controller.isRecording(), false);
  });

  it('2. silence 5 min with humans present → no voice activity stop', async () => {
    const h = makeHarness();
    await h.start();
    h.advance(5 * MIN);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].auto, true);
    assert.match(h.deliverCalls[0].reason, /no voice activity/);
  });

  it('3. qualifying packets every tick keep the session alive', async () => {
    const h = makeHarness();
    await h.start();
    for (let i = 0; i < 24; i++) {
      h.advance(15_000);
      h.pushPacket(60);
    }
    await h.fireTick(); // 6 min in, but activity stamp is 0 s old
    assert.equal(h.deliverCalls.length, 0);
    assert.equal(h.controller.isRecording(), true);
  });

  it('4. under 5 min elapsed → no stop even with empty channel', async () => {
    const h = makeHarness({ humans: [] });
    await h.start();
    h.advance(4 * MIN + 59_000);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 0);
    assert.equal(h.controller.isRecording(), true);
    assert.deepEqual(h.cleared, []);
  });

  it('5. manual /stop clears the timer; later tick is a no-op', async () => {
    const h = makeHarness();
    await h.start();
    await h.controller.stop(h.interaction);
    await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack
    assert.ok(h.cleared.includes(7), 'manual stop cleared interval handle 7');
    assert.equal(h.deliverCalls.length, 1); // the manual deliver
    h.advance(10 * MIN);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1); // no second (auto) deliver
  });

  it('6. auto-stop then manual /stop → one deliver + "Nothing recording."', async () => {
    const h = makeHarness({ humans: [] });
    await h.start();
    h.advance(5 * MIN);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].auto, true);
    const i2 = h.newInteraction();
    await h.controller.stop(i2);
    assert.equal(h.deliverCalls.length, 1); // session already null — no second deliver
    assert.equal(i2._replies[0].content, 'Nothing recording.');
  });

  it('7. members cache missing → no empty-channel stop; silence branch still fires', async () => {
    const h = makeHarness({ membersMissing: true });
    await h.start();
    h.advance(5 * MIN);
    h.pushPacket(60); // fresh qualifying activity at the 5-min mark
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 0); // MAX_SAFE guard: no premature stop
    h.advance(5 * MIN); // now silent for 5 min
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1);
    assert.match(h.deliverCalls[0].reason, /no voice activity/);
  });

  it('8. comfort-noise-only never counts; floor-size packets always do', async () => {
    // 8-byte DTX/comfort-noise packets for > 5 min → silence branch fires
    const noisy = makeHarness();
    await noisy.start();
    for (let i = 0; i < 24; i++) {
      noisy.advance(15_000);
      noisy.pushPacket(8);
    }
    await noisy.fireTick();
    assert.equal(noisy.deliverCalls.length, 1);
    assert.match(noisy.deliverCalls[0].reason, /no voice activity/);

    // 16-byte packets (at the floor, >= counts) → over-count side: never fires
    const active = makeHarness();
    await active.start();
    for (let i = 0; i < 24; i++) {
      active.advance(15_000);
      active.pushPacket(16);
    }
    await active.fireTick();
    assert.equal(active.deliverCalls.length, 0);
    assert.equal(active.controller.isRecording(), true);
  });

  it('auto-stop posts a channel notice to the invoker with the reason', async () => {
    const h = makeHarness({ humans: [], notifyChannel: true });
    await h.controller.record(h.interaction);
    h.advance(6 * 60_000);
    await h.fireTick();
    // [0] is the start notice; the auto-stop notice is the last one
    assert.equal(h.notifyCalls.length, 2);
    const notice = h.notifyCalls.at(-1);
    assert.equal(notice.channelId, 'vc1');
    assert.match(notice.text, /<@invoker1>/);
    assert.match(notice.text, /everyone left the voice channel/);
    assert.match(notice.text, /No audio was captured/i);
  });

  it('channel notice tail reflects delivered files', async () => {
    const h = makeHarness({ humans: [], files: ['a.ogg'], notifyChannel: true });
    await h.controller.record(h.interaction);
    h.advance(6 * 60_000);
    await h.fireTick();
    assert.equal(h.notifyCalls.length, 2);
    const notice = h.notifyCalls.at(-1);
    assert.match(notice.text, /sent to your DMs/i);
    assert.doesNotMatch(notice.text, /No audio/i);
  });

  it('notice says delivery failed when deliverSession reports delivered:false', async () => {
    // humans present + silence → auto-stop with real files, but the DM failed
    const h = makeHarness({
      files: ['a.ogg'],
      deliverReturnsFalse: true,
      notifyChannel: true,
    });
    await h.controller.record(h.interaction);
    h.advance(6 * 60_000);
    await h.fireTick();
    assert.equal(h.notifyCalls.length, 2); // start notice + stop notice
    const notice = h.notifyCalls.at(-1);
    assert.match(notice.text, /Delivery failed/i);
    assert.doesNotMatch(notice.text, /sent to your DMs/i);
    assert.doesNotMatch(notice.text, /No audio/i);
  });

  it('manual /stop sends a Recording stopped. channel notice', async () => {
    const h = makeHarness({ files: ['a.ogg'], notifyChannel: true });
    await h.controller.record(h.interaction);
    await h.controller.stop(h.interaction);
    await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack
    // start notice + stop notice
    assert.equal(h.notifyCalls.length, 2);
    const notice = h.notifyCalls.at(-1);
    assert.equal(notice.channelId, 'vc1');
    assert.match(notice.text, /<@invoker1> Recording stopped\./);
    assert.match(notice.text, /sent to your DMs/i);
    assert.doesNotMatch(notice.text, /auto-stopped/);
  });

  it('record start announces in the voice channel', async () => {
    const h = makeHarness({ notifyChannel: true });
    await h.controller.record(h.interaction);
    assert.equal(h.notifyCalls.length, 1);
    assert.equal(h.notifyCalls[0].channelId, 'vc1');
    assert.equal(
      h.notifyCalls[0].text,
      '<@invoker1> started recording in this voice channel.',
    );
  });

  it('guard paths send no channel notice', async () => {
    const h = makeHarness({ notifyChannel: true });
    const noVc = h.newInteraction();
    noVc.member.voice.channel = null;
    await h.controller.record(noVc); // no VC → ephemeral guard only
    assert.equal(h.notifyCalls.length, 0);
    await h.controller.record(h.interaction); // now recording → start notice
    assert.equal(h.notifyCalls.length, 1);
    const again = h.newInteraction();
    await h.controller.record(again); // already recording → no extra notice
    assert.equal(h.notifyCalls.length, 1);
    await h.controller.stop(h.interaction); // real stop → stop notice
    await flushBackground(); // v3.0.1: the pipeline is backgrounded after the ack
    assert.equal(h.notifyCalls.length, 2);
    const idleStop = h.newInteraction();
    await h.controller.stop(idleStop); // idle stop → no extra notice
    assert.equal(h.notifyCalls.length, 2); // start + stop only
  });

  it('join failure sends no channel notice; ephemeral error intact', async () => {
    const h = makeHarness({ notifyChannel: true, joinVoiceFails: true });
    await h.controller.record(h.interaction);
    assert.equal(h.notifyCalls.length, 0); // join never succeeded → no start notice
    assert.equal(h.controller.isRecording(), false);
    assert.match(
      JSON.stringify(h.interaction._replies.at(-1)),
      /failed to join voice/i,
    );
  });

  it('notice failure never breaks delivery', async () => {
    const h = makeHarness({
      humans: [],
      // only the auto-stop notice throws: a throwing start notice would
      // abort /record, which is not what this scenario pins (failure isolation
      // of the stop-path notice is).
      notifyChannel: async (channelId, text) => {
        if (text.includes('auto-stopped')) throw new Error('Missing Permissions');
      },
    });
    await h.controller.record(h.interaction);
    h.advance(6 * 60_000);
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1); // delivery happened anyway
    assert.equal(h.controller.isRecording(), false);
    // no unhandled rejection: fireTick awaiting covers the notice path
  });

  it('auto-stop notice is sent AFTER deliver resolves (ordering pin)', async () => {
    const h = makeHarness({ humans: [], notifyChannel: true });
    await h.controller.record(h.interaction);
    h.advance(6 * 60_000);
    await h.fireTick();
    assert.deepEqual(h.seq, ['start-notice', 'deliver', 'notice']);
  });
});

function deferSpy() {
  const i = mockInteraction();
  i._defers = [];
  i.deferReply = async (payload) => { i.deferred = true; i._defers.push(payload ?? {}); };
  return i;
}

describe('lifecycle reply visibility (voice channel is the public venue)', () => {
  it('/record success defers EPHEMERAL (public venue is the VC text chat)', async () => {
    const h = makeHarness({});
    const i = deferSpy();
    await h.controller.record(i);
    assert.equal(i._defers.length, 1);
    assert.equal(i._defers[0].flags, MessageFlags.Ephemeral);
  });

  it('/record guard replies stay ephemeral', async () => {
    const h = makeHarness({});
    await h.controller.record(h.interaction);
    const i = deferSpy();
    await h.controller.record(i); // already recording
    assert.equal(i._replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(i._defers.length, 0);
  });

  it('/stop: idle reply ephemeral; a real stop REPLIES the ack ephemeral with NO defer', async () => {
    const h = makeHarness({});
    const idle = deferSpy();
    await h.controller.stop(idle);
    assert.equal(idle._replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(idle._defers.length, 0);
    await h.controller.record(h.interaction);
    const i = deferSpy();
    await h.controller.stop(i);
    // v3.0.1: no deferReply. Deferring then editing showed "thinking…" through
    // the whole ffmpeg encode (~37 s per hour of meeting) — that was the defect.
    assert.equal(i._defers.length, 0, 'a real stop must NOT defer');
    assert.equal(i._replies[0].flags, MessageFlags.Ephemeral);
    assert.match(i._replies[0].content, /^Stopped\. /);
  });
});

// --- v3.0.1 Task 2: immediate /stop ack + backgrounded processing ---
// DEFECT: /stop deferred and awaited the WHOLE stop pipeline, whose middle is
// `MasterMix#finalize()` (the ffmpeg encode, ~37 s per hour of meeting), so the
// operator saw only "thinking…" for minutes. Decision 4: read the stop-time
// snapshot, reply the adaptive ack, THEN run the pipeline in the background —
// no deferReply (deferring IS the defect), and the outcome later EDITS the very
// same ephemeral message.

const ACK_AUDIO_AND_TRANSCRIPT =
  'Stopped. Voice recording and transcription will be sent to your DMs shortly.';
const ACK_AUDIO_ONLY = 'Stopped. Voice recording will be sent to your DMs shortly.';
const ACK_TRANSCRIPT_ONLY =
  'Stopped. Transcription will be sent to your DMs shortly; the recording is kept on disk (/dm audio TRUE to re-enable).';
const ACK_FILES_ONLY =
  'Stopped. Files will be kept on disk (audio DMs are off; /dm audio TRUE to re-enable).';

// v3.0.1 Task 2b: the terminal line a HARD background failure edits the ack to.
// Pinned as a literal here (the export itself is pinned in stop-ack.test.mjs), so
// bot.test.mjs keeps failing for the right reason before the export exists.
const STOP_FAILED_TEXT =
  'Stopped. Something went wrong processing the recording — check the console output.';

/**
 * Interaction mock that records every reply/defer/edit as an ORDERED, tagged
 * call, so both load-bearing facts are observable on ONE object: the ack was
 * the first reply (before any finalize work), and the outcome EDITED that same
 * message. `order` is a shared call log the harness also writes into.
 */
function ackInteraction(order = []) {
  const calls = [];
  return {
    guildId: 'g1',
    user: { id: 'invoker1', send: async () => {} },
    member: {
      voice: { channel: { id: 'vc1', name: 'G', guild: { id: 'g1' } } },
      displayName: 'Invoker',
    },
    guild: { id: 'g1', members: { cache: new Map() } },
    replied: false,
    deferred: false,
    _calls: calls,
    async reply(payload) {
      this.replied = true;
      calls.push({ kind: 'reply', payload });
      order.push('reply');
      return payload;
    },
    async deferReply(payload) {
      this.deferred = true;
      calls.push({ kind: 'defer', payload });
      order.push('defer');
    },
    async editReply(payload) {
      calls.push({ kind: 'edit', payload });
      order.push('edit');
      return payload;
    },
    /** The content of the FIRST interaction response (the ack). */
    ack() {
      const first = calls[0];
      return typeof first?.payload === 'string' ? first.payload : first?.payload?.content;
    },
    /** deferReply calls (must be empty — deferring is the defect). */
    defers() {
      return calls.filter((c) => c.kind === 'defer');
    },
    /** The outcome edit's content, or undefined when no edit happened. */
    lastEdit() {
      const e = calls.filter((c) => c.kind === 'edit').at(-1);
      return typeof e?.payload === 'string' ? e.payload : e?.payload?.content;
    },
    edits() {
      return calls.filter((c) => c.kind === 'edit');
    },
  };
}

/** /stop harness: controllable finalize, deliver, notices and call order. */
function ackHarness(opts = {}) {
  const order = opts.order ?? [];
  const deliverCalls = [];
  const notices = [];
  const writes = [];
  const store = createMapConfigStore({
    transcribeEnabled: opts.transcribeEnabled ?? true,
    dmAudioEnabled: opts.dmAudioEnabled ?? true,
    dmTranscribeEnabled: opts.dmTranscribeEnabled ?? true,
    autostopMinutes: 180,
  });
  // Task 2b: a finalize the test can PARK the pipeline inside, so a config change
  // made after the ack (a mid-encode /dm) is provably observed only by whichever
  // config read the implementation actually performs.
  let releaseFinalize = null;
  const finalizeGate = opts.holdFinalize
    ? new Promise((resolve) => {
        releaseFinalize = resolve;
      })
    : null;
  const master = {
    packetCount: opts.packetCount ?? 120,
    start() {},
    push() {},
    finalize: async () => {
      order.push('finalize');
      // AC3: a finalize that NEVER settles. An implementation that waits for it
      // before replying has not replied by the time this promise is inspected.
      if (opts.neverFinalize) return new Promise(() => {});
      if (finalizeGate) await finalizeGate;
      return opts.master === undefined ? 'C:\\meetings\\x\\master-1.ogg' : opts.master;
    },
  };
  const controller = createSessionController({
    botUserId: 'bot1',
    meetingsRoot: 'C:\\meetings',
    configStore: store,
    now: () => new Date(0),
    setIntervalFn: () => 7,
    clearIntervalFn: () => {},
    joinVoice: async () => ({
      receiver: {
        speaking: { on() {} },
        subscribe: () => ({ on() {}, destroy() {} }),
        subscriptions: new Map(),
      },
      destroy() {},
    }),
    createMasterMix: () => master,
    createRecorder: () => ({
      start: () => ({ dir: 'C:\\meetings\\x', startedAtMs: 0 }),
      addUser() {},
      removeUser() {},
      stop: () => {
        if (opts.recorderStopThrows) throw new Error('stop boom');
        return {
          dir: 'C:\\meetings\\x',
          files: opts.files ?? [],
          userFiles: opts.userFiles ?? [],
          startedAtMs: 0,
        };
      },
    }),
    deliver: async (args) => {
      deliverCalls.push(args);
      order.push('deliver');
      if (opts.deliverThrows) throw new Error('deliver boom');
      if (opts.realDeliver) return deliverSession(args);
      if (args.sendAudio === false) return { delivered: false, suppressed: true };
      return { delivered: opts.delivered ?? true };
    },
    notifyChannel: async (_channelId, t) => {
      order.push('notice');
      notices.push(t);
    },
    transcribe: async () => ({ segments: [], language: 'en' }),
    transcribeDM: async () => {},
    transcribeWriteFile: (p, d) => {
      writes.push({ path: p, data: d });
      return Promise.resolve();
    },
  });
  return { controller, order, deliverCalls, notices, writes, store, releaseFinalize: () => releaseFinalize?.() };
}

/** Run fn with console.log captured; returns the collected lines. */
async function withCapturedLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('v3.0.1 Task 2: /stop acks immediately, then processes in the background', () => {
  it('AC3 ORDER: /stop replies the ack BEFORE finalize even starts (finalize never resolves)', async () => {
    const order = [];
    const h = ackHarness({ order, neverFinalize: true });
    await h.controller.record(mockInteraction());
    order.length = 0; // drop record-phase entries; only the stop path matters

    const i = ackInteraction(order);
    // DELIBERATELY not awaited (Task 3(b)): an implementation that waited for
    // finalize before replying would leave THIS promise pending forever, so
    // nothing here ever waits on the backgrounded pipeline. The mutated code
    // therefore reaches the assertions with the reply missing and FAILS on
    // assert.deepEqual — a hang is not a failing test.
    void h.controller.stop(i);
    await flushBackground(); // drain microtasks/immediates, never the pipeline

    assert.deepEqual(
      order,
      ['reply', 'finalize'],
      `the ack must be the FIRST thing, before finalize: ${JSON.stringify(order)}`,
    );
    assert.ok(
      order.indexOf('reply') < order.indexOf('finalize'),
      'reply-before-finalize ordering',
    );
    assert.equal(i.deferred, false, 'no deferReply — deferring is the defect');
    assert.deepEqual(i.defers(), [], 'deferReply was never called');
    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
    assert.equal(i.lastEdit(), undefined, 'nothing edits the ack while finalize runs');
  });

  it('AC3 ORDER (cont.): the reply happens before ANY of the slow pipeline (deliver/notice too)', async () => {
    const order = [];
    const h = ackHarness({ order });
    await h.controller.record(mockInteraction());
    order.length = 0;
    const i = ackInteraction(order);
    await h.controller.stop(i);
    // The awaited stop() returns right after the ack: everything slow is still
    // pending. The reply is therefore FIRST in the call log.
    assert.deepEqual(
      order,
      ['reply', 'finalize', 'deliver'],
      'reply first; the pipeline has only started',
    );
    await flushBackground();
    // post-reply the pipeline continues: finalize -> deliver -> notice
    assert.deepEqual(order, ['reply', 'finalize', 'deliver', 'notice']);
  });

  it('AC4: the ack adapts to the stop-time snapshot (four strings; the produce gate wins)', async () => {
    const rows = [
      [{ transcribeEnabled: true, dmTranscribeEnabled: true }, ACK_AUDIO_AND_TRANSCRIPT],
      [{ transcribeEnabled: true, dmTranscribeEnabled: false }, ACK_AUDIO_ONLY],
      [{ transcribeEnabled: false, dmTranscribeEnabled: true }, ACK_AUDIO_ONLY],
      [{ transcribeEnabled: false, dmTranscribeEnabled: false }, ACK_AUDIO_ONLY],
    ];
    for (const [cfg, expected] of rows) {
      const h = ackHarness({ ...cfg, dmAudioEnabled: true });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      await h.controller.stop(i);
      assert.equal(
        i.ack(),
        expected,
        `audio ON, transcribeEnabled=${cfg.transcribeEnabled}, dmTranscribe=${cfg.dmTranscribeEnabled}`,
      );
    }
    const offRows = [
      [{ transcribeEnabled: true, dmTranscribeEnabled: true }, ACK_TRANSCRIPT_ONLY],
      [{ transcribeEnabled: true, dmTranscribeEnabled: false }, ACK_FILES_ONLY],
      [{ transcribeEnabled: false, dmTranscribeEnabled: true }, ACK_FILES_ONLY],
    ];
    for (const [cfg, expected] of offRows) {
      const h = ackHarness({ ...cfg, dmAudioEnabled: false });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      await h.controller.stop(i);
      assert.equal(
        i.ack(),
        expected,
        `audio OFF, transcribeEnabled=${cfg.transcribeEnabled}, dmTranscribe=${cfg.dmTranscribeEnabled}`,
      );
    }
  });

  it('AC4: the ack and the delivery share ONE stop-time snapshot (mid-session change wins)', async () => {
    const h = ackHarness({});
    await h.controller.record(mockInteraction());
    // a mid-session /dm audio FALSE must reach BOTH the ack and deliver
    h.store.saveConfig('g1', { dmAudioEnabled: false });
    const i = ackInteraction();
    await h.controller.stop(i);
    assert.equal(i.ack(), ACK_TRANSCRIPT_ONLY);
    await flushBackground();
    assert.equal(h.deliverCalls[0].sendAudio, false, 'the same snapshot feeds deliver');
  });

  it('AC5: delivered — the background outcome EDITS the same ephemeral reply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      const h = ackHarness({ realDeliver: true, master: masterPath });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      await h.controller.stop(i);
      await flushBackground();

      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the ack is the interaction reply');
      assert.equal(i._calls[0].kind, 'reply', 'first response is the reply (not a defer)');
      assert.equal(i.edits().length, 1, 'exactly one outcome edit');
      assert.match(i.lastEdit(), /^Stopped\. Sent the master mix to your DMs\.$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC5: nobody spoke — the outcome edits the ack to the truthful line', async () => {
    const h = ackHarness({ realDeliver: true, master: null, packetCount: 0 });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    await h.controller.stop(i);
    await flushBackground();

    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
    assert.match(i.lastEdit(), /^Stopped\. Nobody spoke — no files\.$/);
  });

  it('AC5: master write failed — the outcome edits the ack (never "nobody spoke")', async () => {
    const h = ackHarness({ realDeliver: true, master: null, packetCount: 42 });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    await h.controller.stop(i);
    await flushBackground();

    assert.match(i.lastEdit(), /The master mix could not be written — see the log\./);
    assert.doesNotMatch(i.lastEdit(), /nobody spoke/i);
  });

  it('AC5: suppressed (/dm audio FALSE) — the outcome edits the ack, never a fake success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      // A real master exists, so deliverSession reaches its `/dm audio FALSE`
      // rule (2) instead of the nothing-captured rule (1). Transcription is off
      // too, so the ack is the files-only wording (nothing is promised at all).
      const h = ackHarness({
        realDeliver: true,
        master: masterPath,
        dmAudioEnabled: false,
        transcribeEnabled: false,
        dmTranscribeEnabled: true,
      });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      await h.controller.stop(i);
      await flushBackground();

      assert.equal(i.ack(), ACK_FILES_ONLY, 'the ack never promises a DM that is off');
      assert.match(i.lastEdit(), /Audio DMs are off \(\/dm audio TRUE to re-enable\)\./);
      assert.doesNotMatch(i.lastEdit(), /Sent the master mix/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC5: delivery failed — the outcome edits the ack with the failure line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      const h = ackHarness({ realDeliver: true, master: masterPath });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      i.user.send = async () => {
        throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      };
      await h.controller.stop(i);
      await flushBackground();

      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
      assert.match(i.lastEdit(), /Could not DM the master mix\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC6 ISOLATION: a background delivery failure is logged, never rejects, notice keeps the true tail', async () => {
    const h = ackHarness({ deliverThrows: true });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    const lines = await withCapturedLogs(async () => {
      await h.controller.stop(i); // must NOT reject (nothing awaits it any more)
      await flushBackground();
    });

    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the operator still got the ack');
    assert.ok(
      lines.some((l) => /delivery failed \(deliver boom\)/.test(l)),
      `expected the loud delivery-failed log, got: ${lines.join(' | ')}`,
    );
    assert.match(
      h.notices.at(-1),
      /Delivery failed — check the console output or the recordings folder\./,
      'the channel notice still carries the truth',
    );
  });

  it('AC6 ISOLATION: an unexpected pipeline rejection is caught by the background .catch, never unhandled', async () => {
    const h = ackHarness({ recorderStopThrows: true });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    const lines = await withCapturedLogs(async () => {
      await h.controller.stop(i); // resolves: the rejection is caught in the background
      await flushBackground();
    });

    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the ack was sent before the throw');
    assert.ok(
      lines.some((l) => /stop pipeline failed \(stop boom\)/.test(l)),
      `expected the background catch to log the rejection, got: ${lines.join(' | ')}`,
    );
    // No STOP notice: the pipeline died at recorder.stop(), long before the
    // tail. (The start notice from /record is the only notice there is.)
    assert.ok(
      h.notices.every((n) => /started recording in this voice channel/.test(n)),
      `expected no stop notice, got: ${JSON.stringify(h.notices)}`,
    );
    // v3.0.1 Task 2b: the two sinks are now DIFFERENT on purpose. The channel
    // notice is absent (above) because the throw precedes it, but the ack — still
    // the operator's own ephemeral message — is edited to the terminal failure
    // line instead of being left promising a DM forever.
    assert.equal(
      i.lastEdit(),
      STOP_FAILED_TEXT,
      'the ack is edited to the terminal failure line when the pipeline dies hard',
    );
  });

  it('AC6: the outcome edit failing (expired interaction) is caught — the pipeline still completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      const h = ackHarness({ realDeliver: true, master: masterPath });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      i.editReply = async () => {
        throw new Error('Unknown interaction (10062)');
      };
      const lines = await withCapturedLogs(async () => {
        await h.controller.stop(i); // resolves
        await flushBackground();
      });
      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
      // The token is dead, so no outcome edit can land anywhere. deliver's
      // reply/edit throws, is not a forbidden-DM error, and is rethrown — the
      // bot's delivery catch logs it; the channel notice is the fallback truth
      // and still fires. (Task 2b: the guarded terminal edit also fails here
      // and is swallowed — see the TASK2B LIMIT pin below.)
      assert.ok(
        lines.some((l) => /delivery failed|Could not DM|Unknown interaction/.test(l)),
        `expected the failure to be logged, got: ${lines.join(' | ')}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // --- Task 2b: the terminal signal on HARD (non-forbidden) failures ---
  //
  // deliver.js rethrows a non-forbidden error BEFORE it replies (see its
  // sendToInvoker catch), and any throw before the channel notice (recorder.stop
  // in the test above) leaves no notice either. Before Task 2 those classes
  // reached the operator as an ephemeral "Something went wrong." from index.js's
  // command error handler; with the pipeline backgrounded that handler is gone,
  // so the ack itself must carry the terminal state — never stay on "…shortly.".

  it('TASK2B: a NON-forbidden delivery throw (50035) edits the ack to the failure line, logs, never rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      const h = ackHarness({ realDeliver: true, master: masterPath });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      // 50035 = Invalid Form Body: NOT a forbidden DM, so deliver rethrows and
      // never reaches its own "Could not DM the master mix" reply.
      i.user.send = async () => {
        throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
      };
      const lines = await withCapturedLogs(async () => {
        await h.controller.stop(i); // must resolve — the rejection is backgrounded
        await flushBackground();
      });

      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the operator still got the ack');
      assert.equal(
        i.lastEdit(),
        STOP_FAILED_TEXT,
        'the background catch edits the ack to the terminal failure line',
      );
      assert.ok(
        lines.some((l) => /delivery failed \(Invalid Form Body\)/.test(l)),
        `expected the loud delivery-failed log, got: ${lines.join(' | ')}`,
      );
      assert.ok(
        !lines.some((l) => /stop pipeline failed/.test(l)),
        'this class is caught by the delivery try in stopSession, not left to the background .catch',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('TASK2B: a statSync ENOENT master (non-forbidden) also edits the ack to the failure line', async () => {
    const missingMaster = join(tmpdir(), 'dmr-no-such-master-2b.ogg');
    const h = ackHarness({ realDeliver: true, master: missingMaster });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    const lines = await withCapturedLogs(async () => {
      await h.controller.stop(i);
      await flushBackground();
    });

    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
    assert.equal(
      i.lastEdit(),
      STOP_FAILED_TEXT,
      'the doomed master path throws out of deliver (statSync ENOENT) → terminal ack edit',
    );
    assert.ok(
      lines.some((l) => /delivery failed \(ENOENT/.test(l)),
      `expected the ENOENT to be logged verbatim, got: ${lines.join(' | ')}`,
    );
  });

  it('TASK2B LIMIT: an edit rejection (expired token / 10062) on the failure path stays caught — ack left stale', async () => {
    const h = ackHarness({ recorderStopThrows: true });
    await h.controller.record(mockInteraction());
    const i = ackInteraction();
    // The interaction token is dead, so even the terminal edit cannot land.
    // This is the documented limit (the DM itself is not token-bound): assert
    // the limitation explicitly instead of assuming the guard works.
    i.editReply = async () => {
      throw new Error('Unknown interaction (10062)');
    };
    const lines = await withCapturedLogs(async () => {
      await h.controller.stop(i); // resolves: the guarded edit never rejects
      await flushBackground();
    });

    assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the ack was sent before the throw');
    assert.equal(i.lastEdit(), undefined, 'the failed edit left the ack stale');
    assert.equal(i.edits().length, 0, 'no edit was recorded — the token was dead');
    assert.ok(
      lines.some((l) => /stop pipeline failed \(stop boom\)/.test(l)),
      `the original failure is still logged, got: ${lines.join(' | ')}`,
    );
  });

  it('TASK2B SNAPSHOT: a /dm audio FALSE landing DURING the encode cannot suppress the promised DM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      const h = ackHarness({ realDeliver: true, master: masterPath, holdFinalize: true });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      await h.controller.stop(i); // ack promises a DM (audio was ON at stop time)
      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT);
      // The pipeline is parked INSIDE finalize, so the /dm lands provably after
      // the ack and before any post-encode config read. stopSession's own,
      // later read used to pick this up → deliver suppressed the audio that the
      // ack had already promised. One threaded snapshot kills that drift.
      h.store.saveConfig('g1', { dmAudioEnabled: false });
      h.releaseFinalize();
      await flushBackground();

      assert.equal(
        h.deliverCalls[0].sendAudio,
        true,
        'deliver uses the SAME stop-time snapshot the ack was built from',
      );
      assert.match(
        i.lastEdit(),
        /^Stopped\. Sent the master mix to your DMs\.$/,
        'the delivered outcome matches what the ack promised',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('TASK3c: a throw AFTER a landed outcome does NOT overwrite it with the failure line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dmr-stopack-'));
    const masterPath = join(root, 'master-1.ogg');
    writeFileSync(masterPath, 'not-really-ogg');
    try {
      // The transcription-target sort runs AFTER the channel notice, so a
      // displayName whose toString() throws makes stopSession reject there —
      // i.e. a throw in the double-edit window, after deliverSession has
      // already edited the ack to the delivered outcome. Latent today (no
      // production input does this); the guard is what keeps the outcome.
      const poisoned = () => ({
        toString() {
          throw new Error('late boom after outcome');
        },
      });
      const h = ackHarness({
        realDeliver: true,
        master: masterPath,
        userFiles: [
          { path: join(root, 'a.ogg'), frames: 200, speechFrames: 200, displayName: poisoned(), startedAtMs: 0 },
          { path: join(root, 'b.ogg'), frames: 200, speechFrames: 200, displayName: poisoned(), startedAtMs: 0 },
        ],
      });
      await h.controller.record(mockInteraction());
      const i = ackInteraction();
      const lines = await withCapturedLogs(async () => {
        await h.controller.stop(i); // resolves — the throw is backgrounded
        await flushBackground();
      });

      assert.equal(i.ack(), ACK_AUDIO_AND_TRANSCRIPT, 'the operator still got the ack');
      // The outcome landed FIRST (exactly one edit) and the notice fired...
      assert.equal(i.edits().length, 1, 'exactly one edit — the landed outcome');
      assert.match(i.lastEdit(), /^Stopped\. Sent the master mix to your DMs\.$/);
      assert.match(
        h.notices.at(-1),
        /Recording stopped\. Result sent to your DMs\./,
        'the channel notice fired before the throw',
      );
      // ...then the later throw is loudly logged, but must NOT replace that
      // outcome with the generic failure line (Task 3(c)).
      assert.ok(
        lines.some((l) => /stop pipeline failed \(late boom after outcome\)/.test(l)),
        `expected the post-outcome throw to be logged, got: ${lines.join(' | ')}`,
      );
      assert.notEqual(i.lastEdit(), STOP_FAILED_TEXT, 'a landed outcome is never clobbered');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- /autostop command (mutable threshold; fake clock, no real sleeps) ---

function mockCommand({ minutes } = {}) {
  return {
    guildId: 'g1',
    options: {
      getInteger: (name) => (name === 'minutes' ? (minutes ?? null) : null),
    },
    user: { id: 'invoker1', username: 'Invoker' },
    _replies: [],
    async reply(p) {
      this._replies.push(p);
      return p;
    },
  };
}

describe('/autostop command', () => {
  it('bare /autostop replies current threshold', async () => {
    const { controller } = makeHarness({});
    const i = mockCommand({}); // interaction: { options: { getInteger: () => null }, reply, ... }
    await controller.autostop(i);
    assert.match(JSON.stringify(i._replies[0]), /currently 5 min/i);
  });

  it('/autostop 10 updates threshold, status reply confirms', async () => {
    const { controller } = makeHarness({});
    await controller.autostop(mockCommand({ minutes: 10 }));
    const i = mockCommand({});
    await controller.autostop(i);
    assert.match(JSON.stringify(i._replies[0]), /currently 10 min/i);
  });

  it('new threshold applies to the LIVE session immediately', async () => {
    const h = makeHarness({ humans: [] }); // empty channel
    await h.controller.record(h.interaction);
    await h.controller.autostop(mockCommand({ minutes: 10 }));
    h.advance(6 * 60_000); // past OLD 5-min gate, under new 10-min gate
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 0); // did NOT stop
    h.advance(4 * 60_000); // now 10 min in
    await h.fireTick();
    assert.equal(h.deliverCalls.length, 1); // stopped, auto
    assert.match(h.deliverCalls[0].reason, /everyone left/);
  });

  it('rejects out-of-range minutes defensively', async () => {
    const { controller } = makeHarness({});
    for (const bad of [0, 181, -5]) {
      const i = mockCommand({ minutes: bad });
      await controller.autostop(i);
      assert.match(JSON.stringify(i._replies[0]), /1-180/);
    }
    const ok = mockCommand({});
    await controller.autostop(ok);
    assert.match(JSON.stringify(ok._replies[0]), /currently 5 min/i); // unchanged
  });

  it('env default seeds the initial threshold', async () => {
    const h = makeHarness({ autoStopThresholdMs: 10 * 60_000 });
    const i = mockCommand({});
    await h.controller.autostop(i);
    assert.match(JSON.stringify(i._replies[0]), /currently 10 min/i);
  });
});

// --- v3.0.0 Task 4: /dm per-guild delivery settings (replaces /record_type) ---

function mockDmCommand({ audio, transcribe } = {}) {
  return {
    guildId: 'g1',
    user: { id: 'u9', username: 'Toggler' },
    options: {
      getString: (n) => {
        if (n === 'audio') return audio ?? null;
        if (n === 'transcribe') return transcribe ?? null;
        return null;
      },
    },
    _replies: [],
    async reply(p) {
      this._replies.push(p);
      return p;
    },
  };
}

describe('/dm command (v3.0.0 Task 4)', () => {
  it('commandData registers /dm with two optional TRUE|FALSE options and no /record_type', () => {
    const dm = commandData.find((c) => c.name === 'dm');
    assert.ok(dm, '/dm command exists');
    assert.match(dm.description, /dms/i);
    const audio = dm.options.find((o) => o.name === 'audio');
    const tr = dm.options.find((o) => o.name === 'transcribe');
    assert.ok(audio, 'audio string option exists');
    assert.ok(tr, 'transcribe string option exists');
    assert.deepEqual(audio.choices.map((c) => c.value), ['TRUE', 'FALSE']);
    assert.deepEqual(tr.choices.map((c) => c.value), ['TRUE', 'FALSE']);
    assert.equal(audio.required, false);
    assert.equal(tr.required, false);
    assert.equal(
      commandData.find((c) => c.name === 'record_type'),
      undefined,
      '/record_type is no longer registered',
    );
  });

  it('bare /dm views both toggles without writing', async () => {
    const h = makeHarness({});
    // Carry-in (iii): pin the absence of a write, not just the seed-default
    // values (those hold whether or not the view wrote anything).
    let writes = 0;
    const origSave = h.store.saveConfig.bind(h.store);
    h.store.saveConfig = (...args) => { writes += 1; return origSave(...args); };
    const i = mockDmCommand({});
    await h.controller.dm(i);
    const text = JSON.stringify(i._replies[0]);
    assert.match(text, /audio/i);
    assert.match(text, /transcript/i);
    assert.match(text, /TRUE/);
    assert.match(text, /Stored per guild; persists across restarts\./);
    assert.equal(writes, 0, 'a bare view must not write anything');
    assert.equal(h.store.getConfig('g1').dmAudioEnabled, true);
    assert.equal(h.store.getConfig('g1').dmTranscribeEnabled, true);
  });

  it('/dm audio FALSE writes only that toggle (partial patch) and confirms both values', async () => {
    const h = makeHarness({});
    const i = mockDmCommand({ audio: 'FALSE' });
    await h.controller.dm(i);
    assert.equal(h.store.getConfig('g1').dmAudioEnabled, false);
    assert.equal(h.store.getConfig('g1').dmTranscribeEnabled, true, 'the other toggle is untouched');
    const text = JSON.stringify(i._replies[0]);
    assert.match(text, /FALSE/);
    assert.match(text, /Stored per guild/);
  });

  it('/dm transcribe FALSE writes only the transcript toggle', async () => {
    const h = makeHarness({});
    await h.controller.dm(mockDmCommand({ transcribe: 'FALSE' }));
    assert.equal(h.store.getConfig('g1').dmTranscribeEnabled, false);
    assert.equal(h.store.getConfig('g1').dmAudioEnabled, true);
  });

  it('/dm rejects an invalid value without writing anything', async () => {
    const h = makeHarness({});
    const i = mockDmCommand({ audio: 'maybe' });
    await h.controller.dm(i);
    assert.match(
      JSON.stringify(i._replies[0]),
      /Audio must be `TRUE` or `FALSE` \(or omit to view\)\./,
    );
    assert.equal(h.store.getConfig('g1').dmAudioEnabled, true, 'nothing written');
  });

  it('/dm with one valid and one invalid option: exactly one reply, nothing written (carry-in iv)', async () => {
    const h = makeHarness({});
    let writes = 0;
    const origSave = h.store.saveConfig.bind(h.store);
    h.store.saveConfig = (...args) => { writes += 1; return origSave(...args); };
    const i = mockDmCommand({ audio: 'FALSE', transcribe: 'bogus' });
    await h.controller.dm(i);
    assert.equal(i._replies.length, 1, 'exactly one reply, no dangling interaction');
    assert.match(
      JSON.stringify(i._replies[0]),
      /Transcribe must be `TRUE` or `FALSE` \(or omit to view\)\./,
    );
    assert.equal(writes, 0, 'an invalid patch writes nothing, not even the valid half');
    assert.equal(h.store.getConfig('g1').dmAudioEnabled, true, 'the guild row is untouched');
  });
});

// --- v3.0.0 Task 3: always-BOTH recording ---
// A session always creates the master mix AND writes per-user files; the
// MASTER-only/single-file mode is gone from the controller and the
// /record_type surface was removed in v3.0.0 Task 4 (/dm replaced it).
describe('always-BOTH recording (v3.0.0 Task 3)', () => {
  it('a store with no record-type notion still builds one master mix and writes per-user files', async () => {
    let masterBuilt = 0;
    const recorderOpts = [];
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: createMapConfigStore({
        transcribeEnabled: true,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 5,
      }),
      createMasterMix: () => {
        masterBuilt++;
        return { start() {}, push() {}, finalize: async () => null };
      },
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: (opts) => {
        recorderOpts.push(opts);
        return {
          opts,
          start: () => ({ dir: 'C:\\meetings\\x' }),
          addUser() {},
          removeUser() {},
          stop: () => ({ dir: 'C:\\meetings\\x', files: [] }),
        };
      },
      deliver: async () => ({ delivered: true }),
    });

    await ctrl.record(mockGuildInteraction('g1'));

    assert.equal(recorderOpts.at(-1).writePerUserFiles, true, 'per-user files are always written');
    assert.equal(masterBuilt, 1, 'the master mix factory is called exactly once');
  });

  it('every session builds its own master mix (two sessions → two masters)', async () => {
    let masterBuilt = 0;
    const h = makeHarness({
      createMasterMix: () => {
        masterBuilt++;
        return { start() {}, push() {}, finalize: async () => null };
      },
    });
    await h.controller.record(h.interaction);
    assert.equal(h.recorderInstances.at(-1).opts.writePerUserFiles, true);
    assert.equal(masterBuilt, 1);
    await h.controller.stop(mockInteraction());
    await h.controller.record(h.interaction);
    assert.equal(h.recorderInstances.at(-1).opts.writePerUserFiles, true);
    // The pre-always-BOTH bug asserted masterBuilt===1 here twice: the second
    // session only built a master because the store still said MASTER.
    assert.equal(masterBuilt, 2, 'the second session builds its own master');
  });

  it('the session-start log line carries the always-BOTH shape and no removed-mode suffix', async () => {
    const h = makeHarness({});
    // Carry-in (v): the old assertion (absence of "(master only)") was
    // tautological — no v2 code path can emit that suffix. Pin the reachable
    // shape instead: the line is the fixed `session started → <dir>` form.
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await h.controller.record(h.interaction);
    } finally {
      console.log = orig;
    }
    const startLine = lines.find((l) => l.includes('session started'));
    assert.ok(startLine, `expected a session-start log line, got: ${lines.join(' | ')}`);
    assert.match(startLine, /session started → .+$/, 'the always-BOTH log line shape');
    assert.doesNotMatch(startLine, /master only/);
  });
});

// --- Task 3: per-guild store isolation + /transcribe (new commands) ---

function makeStoreHarness(opts = {}) {
  const store =
    opts.store ??
    createMapConfigStore({
      transcribeEnabled: opts.transcribeEnabled ?? true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: opts.autostopMinutes ?? 5,
    });
  const makeRecorderList = () => [];
  const recorderOpts = opts.onRecorder ?? ((_o) => {});
  const ctrl = createSessionController({
    botUserId: 'bot1',
    meetingsRoot: 'C:\\meetings',
    configStore: store,
    ...(opts.deps ?? {}),
  });
  return { store, ctrl, recorderOpts };
}

/** /transcribe or /dm interaction mock for arbitrary guild (no real options). */
function mockConfigCommand({ stringName = 'enabled', value = null } = {}) {
  return {
    guildId: 'g1',
    user: { id: 'u9', username: 'Toggler' },
    options: { getString: (n) => (n === stringName ? value : null) },
    _replies: [],
    async reply(p) {
      this._replies.push(p);
      return p;
    },
  };
}

/** Recording interaction for an arbitrary guild (inline harness style). */
function mockGuildInteraction(guildId) {
  return {
    guildId,
    user: { id: 'invoker1' },
    member: {
      voice: { channel: { id: 'vc1', name: 'V', guild: { id: guildId } } },
      displayName: 'Invoker',
    },
    guild: { id: guildId, members: { cache: new Map() } },
    replied: false,
    deferred: false,
    _replies: [],
    async reply(p) {
      this._replies.push(p);
      return p;
    },
    async deferReply() {},
    async editReply(p) {
      this._replies.push(p);
      return p;
    },
  };
}

describe('per-guild config isolation (acceptance criterion 3)', () => {
  it('LEAK: a settings write in g1 leaves g2 untouched; both guilds record always-BOTH', async () => {
    const store = createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    const g1Rec = [];
    const g2Rec = [];
    const mk = (guildId, list) =>
      createSessionController({
        botUserId: 'bot1',
        meetingsRoot: 'C:\\meetings',
        configStore: store,
        createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
        joinVoice: async () => ({
          receiver: {
            speaking: { on() {} },
            subscribe: () => ({ on() {}, destroy() {} }),
            subscriptions: new Map(),
          },
          destroy() {},
        }),
        createRecorder: (opts) => {
          list.push(opts);
          return {
            opts,
            start: () => ({ dir: `C:\\meetings\\${guildId}` }),
            addUser() {},
            removeUser() {},
            stop: () => ({ dir: `C:\\meetings\\${guildId}`, files: [] }),
          };
        },
        deliver: async () => ({ delivered: true }),
      });
    const c1 = mk('g1', g1Rec);
    const c2 = mk('g2', g2Rec);
    // g1: a settings write — must not leak into g2
    await c1.autostop(mockCommand({ minutes: 15 }));
    assert.equal(store.getConfig('g1').autostopMinutes, 15);
    assert.equal(store.getConfig('g2').autostopMinutes, 5);
    // /record in g1 → always-BOTH
    const i1 = mockGuildInteraction('g1');
    await c1.record(i1);
    assert.equal(g1Rec.at(-1).writePerUserFiles, true);
    await c1.stop(mockGuildInteraction('g1'));
    // /record in g2 → also always-BOTH (no leak of g1's settings)
    const i2 = mockGuildInteraction('g2');
    await c2.record(i2);
    assert.equal(g2Rec.at(-1).writePerUserFiles, true);
    assert.equal(store.getConfig('g2').autostopMinutes, 5);
  });

  it('/autostop 15 in g1 only mutates g1', async () => {
    const store = createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    const { ctrl } = makeStoreHarness({ store });
    const i = mockCommand({ minutes: 15 });
    await ctrl.autostop(i);
    assert.equal(store.getConfig('g1').autostopMinutes, 15);
    assert.equal(store.getConfig('g2').autostopMinutes, 5);
  });

  it('default controller (no store injected) works with an implicit Map store', async () => {
    const { ctrl } = makeStoreHarness({}); // no configStore passed via opts.store
    // view-mode reply proves the implicit store read path
    await ctrl.transcribe(mockConfigCommand({ stringName: 'enabled', value: 'TRUE' }));
    const view = mockConfigCommand({ stringName: 'enabled', value: null });
    await ctrl.transcribe(view);
    assert.match(JSON.stringify(view._replies[0]), /enabled/i);
  });

  it('only g1 records in g1: the always-BOTH session dir is guild-scoped (no cross-guild session)', async () => {
    const store = createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    const g1Rec = [];
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: store,
      createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: (opts) => {
        g1Rec.push(opts);
        return {
          opts,
          start: () => ({ dir: 'C:\\meetings\\g1' }),
          addUser() {},
          removeUser() {},
          stop: () => ({ dir: 'C:\\meetings\\g1', files: [] }),
        };
      },
      deliver: async () => ({ delivered: true }),
    });
    await ctrl.record(mockGuildInteraction('g1'));
    assert.equal(g1Rec.at(-1).guildId, 'g1', 'the recorder is bound to the invoking guild');
    assert.equal(g1Rec.at(-1).writePerUserFiles, true);
  });

  it('AC5: /dm audio FALSE persists for its guild across a store restart and never leaks', async () => {
    // File-backed on purpose: closing a :memory: store drops the data, so it
    // cannot prove restart persistence (the in-process round-trip is pinned by
    // db.test.mjs instead).
    const root = mkdtempSync(join(tmpdir(), 'dmr-dm-ac5-'));
    const dbPath = join(root, 'recorder.db');
    const seed = () => ({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    try {
      const db1 = new DatabaseSync(dbPath);
      const ctrl = createSessionController({
        botUserId: 'bot1',
        meetingsRoot: join(root, 'meetings'),
        configStore: createConfigStore(db1, { seedDefaults: seed() }),
      });
      await ctrl.dm(mockConfigCommand({ stringName: 'audio', value: 'FALSE' }));
      assert.equal(ctrl.debugSession(), null);
      assert.equal(
        db1.prepare('SELECT dm_audio_enabled AS v FROM guild_config WHERE guild_id = ?').get('g1').v,
        0,
        'the /dm write reached the row',
      );
      assert.equal(
        db1.prepare('SELECT COUNT(*) AS n FROM guild_config').get().n,
        1,
        'only the invoking guild was written',
      );
      db1.close();

      // Process restart: fresh connection, fresh store, same file.
      const db2 = new DatabaseSync(dbPath);
      try {
        const store2 = createConfigStore(db2, { seedDefaults: seed() });
        assert.equal(store2.getConfig('g1').dmAudioEnabled, false, 'the setting survived the restart');
        assert.equal(store2.getConfig('g2').dmAudioEnabled, true, 'another guild is untouched');
        assert.equal(store2.getConfig('g2').dmTranscribeEnabled, true);
      } finally {
        db2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/transcribe command (Task 3)', () => {
  /** @param {{transcribeEnabled?: boolean}} cfg */
  function transcribeStoreHarness({ transcribeEnabled = true } = {}) {
    const store = createMapConfigStore({
      transcribeEnabled,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    const writeCalls = [];
    const dmCalls = [];
    let transcribed = 0;
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: store,
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: () => ({
        start: () => ({ dir: 'C:\\meetings\\x' }),
        addUser() {},
        removeUser() {},
        stop: () => ({
          dir: 'C:\\meetings\\x',
          files: ['a.ogg'],
          userFiles: [
            { path: 'C:\\meetings\\x\\Alice-u1.ogg', displayName: 'Alice', startedAtMs: 0, frames: 150, speechFrames: 150 },
          ],
          // The real Recorder reports the session zero; the combined render
          // requires it (sessionStartMs must be a number).
          startedAtMs: 0,
        }),
      }),
      deliver: async () => ({ delivered: true }),
      transcribe: async () => {
        transcribed++;
        return { segments: [{ start: 0, end: 1, text: 'hi' }], language: 'en' };
      },
      transcribeDM: async (_id, payload) => {
        dmCalls.push(payload);
      },
      transcribeWriteFile: async (path, data) => {
        writeCalls.push({ path, data });
      },
    });
    async function flush() {
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    }
    return { store, ctrl, writeCalls, dmCalls, countTranscribed: () => transcribed, flush };
  }

  it('commandData includes /transcribe with TRUE/FALSE choices (optional)', () => {
    const tc = commandData.find((c) => c.name === 'transcribe');
    assert.ok(tc, 'transcribe command exists');
    const opt = tc.options.find((o) => o.name === 'enabled');
    assert.ok(opt, 'enabled string option exists');
    assert.deepEqual(opt.choices.map((c) => c.value), ['TRUE', 'FALSE']);
    assert.equal(opt.required, false);
  });

  it('bare /transcribe reads the plain toggle: enabled, with no mode clause', async () => {
    const { ctrl } = transcribeStoreHarness({});
    const view = mockConfigCommand({ stringName: 'enabled', value: null });
    await ctrl.transcribe(view);
    const text = JSON.stringify(view._replies[0]);
    assert.match(text, /enabled/i);
    assert.doesNotMatch(text, /mode/i, 'the removed mode clause never appears (no "mode: undefined")');
  });

  it('bare /transcribe with the toggle FALSE shows disabled', async () => {
    const { ctrl } = transcribeStoreHarness({ transcribeEnabled: false });
    const view = mockConfigCommand({ stringName: 'enabled', value: null });
    await ctrl.transcribe(view);
    assert.match(JSON.stringify(view._replies[0]), /disabled/i);
  });

  it('/transcribe FALSE calls saveConfig(guildId, {transcribeEnabled: false})', async () => {
    const { store, ctrl } = transcribeStoreHarness({});
    const off = mockConfigCommand({ stringName: 'enabled', value: 'FALSE' });
    await ctrl.transcribe(off);
    assert.equal(store.getConfig('g1').transcribeEnabled, false);
    const on = mockConfigCommand({ stringName: 'enabled', value: 'TRUE' });
    await ctrl.transcribe(on);
    assert.equal(store.getConfig('g1').transcribeEnabled, true);
  });

  it('stop-time gate = the plain transcribeEnabled toggle: true → one per-user call + combined write', async () => {
    const h = transcribeStoreHarness({ transcribeEnabled: true });
    await h.ctrl.record(mockGuildInteraction('g1'));
    await h.ctrl.stop(mockGuildInteraction('g1'));
    await h.flush();
    assert.equal(h.countTranscribed(), 1, 'the per-user track is transcribed once');
    assert.equal(h.writeCalls.length, 1);
    assert.match(h.writeCalls[0].path, /transcript-.*\.md$/);
    assert.equal(h.dmCalls.length, 1);
  });

  it('stop-time gate = the plain transcribeEnabled toggle: false → zero calls, no write, no DM', async () => {
    const h = transcribeStoreHarness({ transcribeEnabled: false });
    await h.ctrl.record(mockGuildInteraction('g1'));
    await h.ctrl.stop(mockGuildInteraction('g1'));
    await h.flush();
    assert.equal(h.countTranscribed(), 0);
    assert.equal(h.writeCalls.length, 0);
    assert.equal(h.dmCalls.length, 0);
  });

  it('SNAPSHOT: /transcribe FALSE mid-session DOES gate the in-flight session stop-time transcription', async () => {
    const h = transcribeStoreHarness({});
    await h.ctrl.record(mockGuildInteraction('g1'));
    await h.ctrl.transcribe(mockConfigCommand({ stringName: 'enabled', value: 'FALSE' }));
    assert.equal(h.store.getConfig('g1').transcribeEnabled, false);
    await h.ctrl.stop(mockGuildInteraction('g1'));
    await h.flush();
    assert.equal(h.countTranscribed(), 0);
    assert.equal(h.writeCalls.length, 0);
    assert.equal(h.dmCalls.length, 0);
  });

  it('SNAPSHOT: /transcribe FALSE mid-session with a later TRUE re-enables at stop', async () => {
    const h = transcribeStoreHarness({});
    await h.ctrl.record(mockGuildInteraction('g1'));
    await h.ctrl.transcribe(mockConfigCommand({ stringName: 'enabled', value: 'FALSE' }));
    await h.ctrl.stop(mockGuildInteraction('g1'));
    await h.flush();
    assert.equal(h.countTranscribed(), 0);
    // next session with TRUE enabled → transcription happens again
    await h.ctrl.transcribe(mockConfigCommand({ stringName: 'enabled', value: 'TRUE' }));
    await h.ctrl.record(mockGuildInteraction('g1'));
    await h.ctrl.stop(mockGuildInteraction('g1'));
    await h.flush();
    assert.equal(h.countTranscribed(), 1);
  });
});

describe('autostop immediacy via the store (Task 3)', () => {
  it('/autostop 15 mid-session: next tick uses thresholdMs=15min from the store', async () => {
    const store = createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    let clockMs = Date.UTC(2026, 8, 19, 12, 0, 0);
    let tickFn = null;
    const ctrl = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: store,
      now: () => new Date(clockMs),
      autoStopThresholdMs: 5 * MIN,
      setIntervalFn: (fn) => { tickFn = fn; return 7; },
      clearIntervalFn: () => {},
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: () => ({
        start: () => ({ dir: 'C:\\meetings\\x' }),
        addUser() {},
        removeUser() {},
        stop: () => ({ dir: 'C:\\meetings\\x', files: [] }),
      }),
      deliver: async () => ({ delivered: true }),
    });
    await ctrl.record(mockGuildInteraction('g1'));
    await ctrl.autostop(mockCommand({ minutes: 15 }));
    assert.equal(store.getConfig('g1').autostopMinutes, 15);
    // 6 min in with zero activity: old 5-min threshold would fire, new must not
    clockMs += 6 * MIN;
    tickFn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctrl.isRecording(), true, 'former 5-min gate must no longer apply');
    clockMs += 9 * MIN;
    tickFn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctrl.isRecording(), false, '15-min threshold fired');
  });
});

describe('createMapConfigStore spec parity (db.js shared implementation)', () => {
  it('exports getConfig/saveConfig with the v2 fields and validation matching db.js', () => {
    const store = createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    assert.deepEqual(Object.keys(store).sort(), ['getConfig', 'saveConfig']);
    assert.deepEqual(store.getConfig('g1'), {
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    store.saveConfig('g1', { autostopMinutes: 15 });
    assert.equal(store.getConfig('g1').autostopMinutes, 15);
    assert.equal(store.getConfig('g2').autostopMinutes, 5);
    // Partial patch: one toggle moves, the other and the rest stay put.
    store.saveConfig('g1', { dmAudioEnabled: false });
    assert.equal(store.getConfig('g1').dmAudioEnabled, false);
    assert.equal(store.getConfig('g1').dmTranscribeEnabled, true);
    assert.throws(() => store.saveConfig('g1', { dmAudioEnabled: 'nope' }), /dmAudioEnabled must be boolean/);
    assert.throws(() => store.saveConfig('g1', { dmTranscribeEnabled: 'nope' }), /dmTranscribeEnabled must be boolean/);
    assert.throws(() => store.saveConfig('g1', { autostopMinutes: 0 }));
    assert.throws(() => store.saveConfig('g1', { transcribeEnabled: 'nope' }));
  });
});

// --- per-user combined transcription (Task 3 orchestration) ---
// Fully inline harness (own describe, own mocks): existing tests and the
// shared makeHarness are untouched. logEvent observability comes from a
// temporary console.log capture (src/log.js is console-backed), restored in
// finally — no new production seam needed.
describe('per-user combined transcription', () => {
  const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
  const base = (p) => p.split(/[\\/]/).pop();

  function combinedHarness(opts = {}) {
    const writes = [];
    const dmCalls = [];
    const seen = []; // masterPath param of every transcribe call, in call order
    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      ...(opts.master !== undefined
        ? {
            createMasterMix: () => ({
              start() {},
              push() {},
              finalize: async () => opts.master,
            }),
          }
        : {}),
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: () => ({
        start: () => ({ dir: 'C:\\meetings\\x' }),
        addUser() {},
        removeUser() {},
        stop: () => {
          const result = {
            dir: 'C:\\meetings\\x',
            files: opts.files ?? [],
            userFiles: opts.userFiles ?? [],
            ...(opts.timelinePath !== undefined ? { timelinePath: opts.timelinePath } : {}),
          };
          // Carry-in (ii): an old-shape recorder reports no startedAtMs; the
          // controller must still produce a combined transcript (no silent loss).
          if (!opts.omitStartMs) result.startedAtMs = opts.sessionStartMs ?? T0;
          return result;
        },
      }),
      deliver: opts.deliverThrows
        ? async () => {
            throw new Error('deliver boom');
          }
        : async () => ({ delivered: true }),
      ...(opts.notifyChannel !== undefined ? { notifyChannel: opts.notifyChannel } : {}),
      transcribe:
        opts.transcribe ??
        (async (args) => {
          seen.push(args.masterPath);
          return {
            segments: [{ start: 1, end: 2, text: `hi ${base(args.masterPath)}` }],
            language: 'en',
          };
        }),
      transcribeDM: async (id, payload) => {
        dmCalls.push({ id, payload });
      },
      transcribeOpts: opts.transcribeOpts ?? { model: 'base' },
      ...(opts.readTextFile ? { readTextFile: opts.readTextFile } : {}),
      ...(opts.now !== undefined ? { now: () => new Date(opts.now) } : {}),
      transcribeWriteFile: (path, data) => {
        writes.push({ path, data });
        return Promise.resolve();
      },
      ...(opts.transcribeEnabled !== undefined
        ? { transcribeEnabled: opts.transcribeEnabled }
        : {}),
    });
    return { controller, writes, dmCalls, seen };
  }

  async function flushAsync() {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  }

  /** Run fn with console.log captured; returns collected lines. */
  async function withLogs(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return lines;
  }

  const track = (name, startedAtMs, frames) => ({
    path: `C:\\meetings\\x\\${name}-u1.ogg`,
    displayName: name,
    startedAtMs,
    frames,
    speechFrames: frames,
  });

  it('per-user files: one transcribe call per file, one combined write, combined DM, speakers log', async () => {
    const userFiles = [track('Alice', T0 + 10_000, 120), track('Bob', T0, 200)];
    const { controller, writes, dmCalls, seen } = combinedHarness({ userFiles });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    // each user file transcribed once, via the masterPath param; no master exists
    assert.deepEqual([...seen].sort(), [userFiles[0].path, userFiles[1].path]);
    // one write to the combined transcript name
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /transcript-.*\.md$/);
    // both tracks present with labels and session-relative offsets:
    // Bob started at session start (seg +1s -> 00:01), Alice joined +10s (-> 00:11)
    assert.match(writes[0].data, /\[00:01\] \*\*Bob:\*\* hi Bob/);
    assert.match(writes[0].data, /\[00:11\] \*\*Alice:\*\* hi Alice/);
    // DM exactly once, invisible-string contract: same content as 1.6.0
    assert.equal(dmCalls.length, 1);
    assert.equal(dmCalls[0].payload.content, 'Your meeting transcript:');
    assert.deepEqual(dmCalls[0].payload.files, [writes[0].path]);
    // console log gains the speaker count (integration-gate exemption)
    const delivered = lines.filter((l) => l.includes('transcript delivered'));
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /\(2 segments, 2 tracks, 2 with speech\)/);
  });

  it('a track with no segments: summary counts it, .md names it above the entries, per-track lines logged, rejoin noted', async () => {
    const mk = (name, file, startedAtMs, frames = 120) => ({
      path: `/m/x/${file}`, displayName: name, startedAtMs, frames, speechFrames: frames,
    });
    const userFiles = [mk('Alice', 'Alice-u1.ogg', T0), mk('Billy', 'Billy-u2.ogg', T0), mk('Billy', 'Billy-u2-2.ogg', T0 + 800_000)];
    const tlText = [
      { type: 'session', t0: T0 },
      { type: 'track', userId: 'u2', displayName: 'Billy', file: 'Billy-u2.ogg', t: T0, deltaMs: 0 },
      { type: 'track', userId: 'u2', displayName: 'Billy', file: 'Billy-u2-2.ogg', t: T0 + 800_000, deltaMs: 800_000 },
    ].map((e) => JSON.stringify(e)).join('\n');
    const reads = [];
    const { controller, writes } = combinedHarness({
      userFiles,
      timelinePath: '/m/x/timeline-2026.jsonl',
      readTextFile: async (p) => { reads.push(p); return tlText; },
      transcribe: async (args) => ({
        segments: /Alice/.test(args.masterPath) ? [{ start: 1, end: 2, text: 'hi' }] : [],
        language: 'en',
      }),
    });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.deepEqual(reads, ['/m/x/timeline-2026.jsonl']);
    const md = writes[0].data;
    const iNote = md.indexOf('_No speech recognized for **Billy** (Billy-u2.ogg)._');
    assert.ok(iNote > 0 && iNote < md.indexOf('[00:01]'), md);
    assert.match(md, /_Billy: 2 tracks in this meeting \(left and rejoined at 13:20\)/);
    const out = lines.join('\n');
    assert.match(out, /\(1 segments, 3 tracks, 1 with speech\)/);
    assert.match(out, /transcribed Alice-u1\.ogg: 1 segments/);
    assert.match(out, /no speech recognized in Billy-u2\.ogg \(0 segments\) — audio kept/);
  });

  it('a missing timelinePath (pre-3.0.2 session) logs once and still renders', async () => {
    const userFiles = [{ path: '/m/x/A-u1.ogg', displayName: 'A', startedAtMs: T0, frames: 120, speechFrames: 120 }];
    const { controller, writes } = combinedHarness({ userFiles });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.equal(writes.length, 1);
    assert.equal(lines.filter((l) => /no timeline file/i.test(l)).length, 1);
  });

  it('an unreadable timeline file logs once and still renders', async () => {
    const userFiles = [{ path: '/m/x/A-u1.ogg', displayName: 'A', startedAtMs: T0, frames: 120, speechFrames: 120 }];
    const { controller, writes } = combinedHarness({
      userFiles,
      timelinePath: '/m/x/timeline-gone.jsonl',
      readTextFile: async () => { throw new Error('ENOENT'); },
    });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.equal(writes.length, 1);
    assert.equal(lines.filter((l) => /no timeline file/i.test(l)).length, 1);
  });

  it('master-only session (no per-user tracks): no transcript at all — the master .md route is gone', async () => {
    const { controller, writes, seen, dmCalls } = combinedHarness({
      master: 'C:\\meetings\\x\\master-test.ogg',
      userFiles: [],
    });
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    await flushAsync();
    assert.deepEqual(seen, [], 'the master path is never a transcription target');
    assert.equal(writes.length, 0, 'no master-*.md is ever produced');
    assert.equal(dmCalls.length, 0);
  });

  it('an old-shape stop() result without startedAtMs still renders the combined transcript (carry-in ii)', async () => {
    // The sibling mdPath call falls back to current.joinedAt; sessionStartMs
    // did not, so an old-shape recorder (no startedAtMs) made the render throw
    // and the transcript was lost silently. Pin that it still lands.
    const userFiles = [track('Alice', T0 + 10_000, 120)];
    const { controller, writes, dmCalls } = combinedHarness({
      userFiles,
      omitStartMs: true,
      now: T0,
    });
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    await flushAsync();
    assert.equal(writes.length, 1, 'the combined transcript is still written');
    assert.match(writes[0].path, /transcript-.*\.md$/);
    assert.equal(dmCalls.length, 1, 'and it is still DM\'d');
  });

  it('one track rejects: combined proceeds without it, log names the failed file', async () => {
    const userFiles = [track('Alice', T0, 150), track('Bob', T0 + 5_000, 150)];
    const { controller, writes, dmCalls } = combinedHarness({
      userFiles,
      transcribe: async (args) => {
        if (args.masterPath.includes('Bob')) throw new Error('sidecar died');
        return { segments: [{ start: 0, end: 1, text: 'only alice' }], language: 'en' };
      },
    });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0].data, /only alice/);
    assert.doesNotMatch(writes[0].data, /Bob/);
    assert.equal(dmCalls.length, 1);
    assert.ok(
      lines.some((l) => /transcription failed/.test(l) && l.includes('Bob-u1.ogg')),
      `expected failed-track log naming Bob-u1.ogg, got: ${lines.join(' | ')}`,
    );
  });

  it('all tracks reject: log-only, no write, no DM, no crash (Decision 6)', async () => {
    const userFiles = [track('Alice', T0, 150), track('Bob', T0 + 5_000, 150)];
    const { controller, writes, dmCalls } = combinedHarness({
      userFiles,
      transcribe: async () => {
        throw new Error('sidecar down');
      },
    });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction()); // must not reject
      await flushAsync();
    });
    assert.equal(writes.length, 0);
    assert.equal(dmCalls.length, 0);
    assert.ok(
      lines.some((l) => /transcription failed/.test(l)),
      `expected a transcription-failed log line, got: ${lines.join(' | ')}`,
    );
  });

  it('near-empty track (speechFrames < MIN_TRACK_FRAMES) never reaches transcribe; skip is logged by basename', async () => {
    const userFiles = [track('Tiny', T0, 99), track('Alice', T0 + 5_000, 100)];
    const { controller, seen, writes } = combinedHarness({ userFiles });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.deepEqual(seen, [userFiles[1].path]); // Tiny never transcribed
    assert.equal(writes.length, 1);
    assert.doesNotMatch(writes[0].data, /Tiny/);
    assert.ok(
      lines.some((l) => l.includes('Tiny-u1.ogg') && /skip/i.test(l)),
      `expected skip log naming Tiny-u1.ogg, got: ${lines.join(' | ')}`,
    );
  });

  it('a padded track with little speech is skipped on speechFrames, not frames', async () => {
    const quiet = { ...track('Quiet', T0, 50_000), speechFrames: 40 };
    const userFiles = [quiet, track('Alice', T0 + 5_000, 150)];
    const { controller, seen } = combinedHarness({ userFiles });
    const lines = await withLogs(async () => {
      await controller.record(mockInteraction());
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.deepEqual(seen, [userFiles[1].path]);
    assert.ok(
      lines.some((l) => l.includes('Quiet-u1.ogg') && /50000 frames, 40 speech/.test(l)),
      `expected skip log with both counts, got: ${lines.join(' | ')}`,
    );
  });

  it('enqueue order: sorted by startedAtMs, ties by displayName (not Map/finalize order)', async () => {
    const userFiles = [
      track('Carol', T0 + 30_000, 150),
      track('Zoe', T0, 150),
      track('Amy', T0, 150), // tie with Zoe: displayName wins
      track('Tiny', T0 + 1_000, 5),
    ];
    const { controller, seen } = combinedHarness({ userFiles });
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    await flushAsync();
    assert.deepEqual(seen, [
      'C:\\meetings\\x\\Amy-u1.ogg',
      'C:\\meetings\\x\\Zoe-u1.ogg',
      'C:\\meetings\\x\\Carol-u1.ogg',
    ]);
  });

  it('duplicate paths (same-user same-ms rejoin edge) transcribe that path once', async () => {
    const dup = track('Alice', T0, 150);
    const userFiles = [dup, { ...dup }, track('Bob', T0 + 5_000, 150)];
    const { controller, seen, writes } = combinedHarness({ userFiles });
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    await flushAsync();
    assert.deepEqual(seen, [dup.path, 'C:\\meetings\\x\\Bob-u1.ogg']);
    assert.equal(writes.length, 1);
  });

  it('transcript kickoff happens AFTER the stop channel notice (per-user route)', async () => {
    const seq = [];
    const userFiles = [track('Alice', T0, 150)];
    const { controller } = combinedHarness({
      userFiles,
      notifyChannel: async () => {
        seq.push('notice');
      },
      transcribe: async () => {
        seq.push('transcribe');
        return { segments: [{ start: 0, end: 1, text: 'hi' }], language: 'en' };
      },
    });
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    await flushAsync();
    // ['notice'(start), 'notice'(stop), kickoff] — a kickoff moved ahead of the
    // stop notice would fail this exact-order assertion.
    assert.deepEqual(seq, ['notice', 'notice', 'transcribe']);
  });

  it('manual /stop: a background delivery rejection is logged, does NOT reject, and the notice keeps the true tail', async () => {
    const userFiles = [track('Alice', T0, 150)];
    const notices = [];
    const { controller, writes, seen } = combinedHarness({
      userFiles,
      // A recorded file exists, so the stop tail reaches its delivery branch
      // (an empty file list would answer "nobody spoke" instead).
      files: ['a.ogg'],
      deliverThrows: true,
      notifyChannel: async (_channelId, t) => notices.push(t),
    });
    await controller.record(mockInteraction());
    const lines = await withLogs(async () => {
      // v3.0.1: nothing awaits stopSession any more, so the manual-mode rethrow
      // tail is gone — the failure must be LOGGED loudly, not thrown into the
      // background continuation (an unhandled rejection would fail the run).
      await controller.stop(mockInteraction());
      await flushAsync();
    });
    assert.ok(
      lines.some((l) => /delivery failed \(deliver boom\)/.test(l)),
      `expected a loud delivery-failed log, got: ${lines.join(' | ')}`,
    );
    // ...but the tracks are on disk, so the sidecar must have run anyway.
    assert.deepEqual(seen, [userFiles[0].path]);
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /transcript-.*\.md$/);
    // AC6: the channel notice still carries the truth for this session.
    assert.match(
      notices.at(-1),
      /Delivery failed — check the console output or the recordings folder\./,
    );
  });
});

test('command deployer registers once per guild and dedupes repeats', async () => {
  const puts = [];
  const logs = [];
  const deploy = createCommandDeployer({
    rest: { put: async (route, opts) => { puts.push({ route, body: opts.body }); } },
    getClientId: () => 'CLIENT1',
    onLog: (msg) => logs.push(msg),
  });
  assert.equal(await deploy('G1'), true);
  await deploy('G1'); // second call for same guild: no second PUT
  assert.equal(puts.length, 1);
  assert.equal(puts[0].route, '/applications/CLIENT1/guilds/G1/commands');
  assert.ok(Array.isArray(puts[0].body) && puts[0].body.length >= 2);
  assert.ok(puts[0].body.every((c) => typeof c.name === 'string')); // command shapes, not a count snapshot
  assert.match(logs.join('\n'), /Registered slash commands for guild G1/);
});

test('failed registration is caught, logged, and retryable', async () => {
  let fail = true;
  const logs = [];
  const deploy = createCommandDeployer({
    rest: { put: async () => { if (fail) throw Object.assign(new Error('50001 Missing Access'), { code: 50001 }); } },
    getClientId: () => 'CLIENT1',
    onLog: (msg) => logs.push(msg),
  });
  assert.equal(await deploy('G2'), false); // must not throw
  assert.match(logs.join('\n'), /slash command registration FAILED for guild G2/);
  fail = false;
  assert.equal(await deploy('G2'), true); // failure must NOT dedupe: retry allowed
  assert.match(logs.join('\n'), /Registered slash commands for guild G2/);
});

test('concurrent deploys for one guild share a single in-flight PUT', async () => {
  const puts = [];
  const logs = [];
  let resolvePut;
  const putGate = new Promise((res) => { resolvePut = res; });
  const deploy = createCommandDeployer({
    rest: { put: async () => { puts.push(1); await putGate; } },
    getClientId: () => 'CLIENT1',
    onLog: (msg) => logs.push(msg),
  });
  const p1 = deploy('G9');
  const p2 = deploy('G9'); // no await between: mirrors startup loop overlapping a GUILD_CREATE burst
  resolvePut();
  assert.equal(await p1, true);
  assert.equal(await p2, true);
  assert.equal(puts.length, 1);
});

test('deployer skips quietly before client is ready (no clientId)', async () => {
  const logs = [];
  const deploy = createCommandDeployer({
    rest: { put: async () => { throw new Error('must not be called'); } },
    getClientId: () => undefined,
    onLog: (msg) => logs.push(msg),
  });
  assert.equal(await deploy('G3'), false);
  assert.equal(logs.length, 0);
});

test('deployer forget() lets a rejoined guild re-register (kick+reinvite flow)', async () => {
  const puts = [];
  const deploy = createCommandDeployer({
    rest: { put: async (route) => { puts.push(route); } },
    getClientId: () => 'CLIENT1',
    onLog: () => {},
  });
  await deploy('GK');
  deploy.forget('GK');           // GUILD_DELETE (kicked)
  const again = await deploy('GK'); // GUILD_CREATE (reinvited)
  assert.equal(again, true);
  assert.equal(puts.filter((r) => r.includes('/guilds/GK/')).length, 2);
});

test('forget() during an in-flight PUT: late success is not remembered', async () => {
  const puts = [];
  let resolvePut;
  const gate = new Promise((r) => { resolvePut = r; });
  const deploy = createCommandDeployer({
    rest: { put: async (route) => { puts.push(route); await gate; return { route }; } },
    getClientId: () => 'CLIENT1',
    onLog: () => {},
  });
  const first = deploy('GQ');        // PUT in flight (no await)
  deploy.forget('GQ');               // kick races the PUT
  resolvePut();
  assert.equal(await first, true);   // the in-flight call itself still reports success
  assert.equal(await deploy('GQ'), true); // rejoin: must do a SECOND PUT, not dedupe
  assert.equal(puts.filter((r) => r.includes('/guilds/GQ/')).length, 2);
});

test('forget() on an unknown guild is a harmless no-op', async () => {
  const puts = [];
  const deploy = createCommandDeployer({
    rest: { put: async (route) => { puts.push(route); return {}; } },
    getClientId: () => 'CLIENT1',
    onLog: () => {},
  });
  deploy.forget('NEVER-SEEN');       // must not throw
  assert.equal(await deploy('NEVER-SEEN'), true);
  assert.equal(await deploy('NEVER-SEEN'), true);
  assert.equal(puts.length, 1);      // forget-seeded epoch: first deploy registers, second dedupes
});

// --- Task 4: /help command + /record settings hint ---

describe('help command (Task 4)', () => {
  const REQUIRED_COMMANDS = ['record', 'stop', 'dm', 'transcribe', 'autostop', 'help'];
  const TIP = 'Tip: /autostop, /transcribe, /dm change settings; /help lists everything.';

  it('commandData includes a help command', () => {
    const help = commandData.find((c) => c.name === 'help');
    assert.ok(help, 'help command exists');
    assert.match(help.description, /list/i);
  });

  it('buildHelpText mentions each command name, a description, and an example', () => {
    const text = buildHelpText();
    for (const name of REQUIRED_COMMANDS) {
      assert.ok(text.includes(`/${name}`), `mentions /${name}`);
    }
    // example invocations (one per command)
    for (const example of ['/dm audio FALSE', '/transcribe TRUE', '/autostop 15', '/record', '/stop', '/help']) {
      assert.ok(text.includes(example), `example invocation ${example} present`);
    }
    assert.doesNotMatch(text, /record_type/, 'the removed command never appears in /help');
  });

  it('/help interaction replies EPHEMERAL with names, descriptions, and examples', async () => {
    const h = makeHarness({});
    const i = h.newInteraction();
    await h.controller.help(i);
    assert.equal(i._replies.length, 1);
    assert.equal(i._replies[0].flags, MessageFlags.Ephemeral);
    const text = i._replies[0].content;
    assert.ok(typeof text === 'string' && text.length > 0, 'reply content is a string');
    for (const name of REQUIRED_COMMANDS) {
      assert.ok(text.includes(`/${name}`), `reply mentions /${name}`);
      assert.ok(text.includes(`/dm audio FALSE`), `reply has a /dm example`);
      assert.ok(text.includes(`/transcribe TRUE`), `reply has a /transcribe example`);
      assert.ok(text.includes(`/autostop 15`), `reply has an /autostop example`);
    }
  });

  it('/record reply content ends with the exact tip line', async () => {
    const h = makeHarness({ notifyChannel: true });
    await h.controller.record(h.interaction);
    const editReplies = h.interaction._replies;
    assert.ok(editReplies.length >= 1);
    const payload = editReplies.at(-1);
    // editReply is called with a bare string in record() — normalize.
    const content = typeof payload === 'string' ? payload : payload.content;
    assert.equal(
      content.slice(-TIP.length),
      TIP,
      `expected content to end with the tip, got: ${JSON.stringify(content)}`,
    );
    // old assertion text must still be present (never weakened)
    assert.match(content, /Recording in \*\*G\*\*\. Use `\/stop` when done\./);
    assert.doesNotMatch(content, /record_type/, 'the removed command is gone from the /record tip');
  });
});

// --- bot-level gate harness (v3.0.0 Task 6) ---
// The v2.1.0 speech-window spy deps (the sidecar writer factory, the
// appendFile/touch seams) and the sidecar reader seam died with their modules
// in Task 6, and with them the two "the sidecar is never wired" cases: once the
// machinery is deleted those assertions can no longer fail. What stays here is
// the harness for the two cases that still have a subject — the always-BOTH
// shared-zero pin and the gate's REAL-timer path (the Task 6 re-pin: the
// default setTimeout/clearTimeout with SHORT confirm/silence windows, never a
// multi-second sleep).

const HARNESS_T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Synchronous fake for the gate's timer pair, injected through the
 * controller's `gateTimers` seam (`{ setTimeout, clearTimeout }` — the gate
 * spreads it into its options). Nothing sleeps: `fire()` runs every timer
 * armed since the last call, in arming order, so the deterministic gate cases
 * carry no real-timer slack at all (Task 7b).
 */
function fakeGateTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    /** Run every currently-armed timer callback once, in arming order. */
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    /** How many timers are armed (a leak/behaviour probe). */
    armed() {
      return pending.size;
    },
  };
}

/**
 * Bot-level gate harness: fake clock, the receiver.speaking mock (the gate is
 * driven through it), and the recorder/master stubs. `realTimers: true` runs
 * the gate's DEFAULT setTimeout/clearTimeout with the short confirm/silence
 * windows given (tens of ms); the deterministic cases pass no gate options and
 * never arm a gate timer at all.
 */
function gateHarness(opts = {}) {
  const T0 = HARNESS_T0;
  const masterStartArgs = [];
  const speakHandlers = {};
  let clockMs = T0;

  const gateTimers = opts.realTimers === true
    ? { confirmMs: opts.confirmMs ?? 30, silenceMs: opts.silenceMs ?? 30 }
    : {};

  const ctrl = createSessionController({
    botUserId: 'bot1',
    meetingsRoot: 'C:\\meetings',
    configStore: createMapConfigStore({
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 180,
    }),
    now: () => new Date(clockMs),
    setIntervalFn: () => 7,
    clearIntervalFn: () => {},
    joinVoice: async () => ({
      receiver: {
        speaking: {
          on(ev, fn) { speakHandlers[ev] = fn; },
        },
        subscribe: () => ({ on() {}, destroy() {} }),
        subscriptions: new Map(),
      },
      destroy() {},
    }),
    createRecorder: (recOpts) => {
      const rec = {
        opts: recOpts,
        start: () => ({
          dir: 'C:\\meetings\\x',
          // pin: bot must use this (not a second clock read) as the
          // master.start() argument
          startedAtMs: T0 + (opts.recorderStartShiftMs ?? 0),
        }),
        addUser() {},
        removeUser() {},
        markConfirmed() {},
        stop: () => ({
          dir: 'C:\\meetings\\x',
          files: [],
          userFiles: [],
          startedAtMs: T0 + (opts.recorderStartShiftMs ?? 0),
        }),
      };
      rec.packet = (userId) => recOpts.onPacket(userId, Buffer.alloc(60));
      return rec;
    },
    ...(opts.master
      ? {
          createMasterMix: () => ({
            start(atMs) { masterStartArgs.push(atMs); },
            push() {},
            finalize: async () => null,
          }),
          masterBitrate: '24k',
        }
      : {}),
    gateTimers,
    deliver: async () => ({ delivered: true }),
  });

  async function start() {
    await ctrl.record(mockInteraction({ user: { id: 'invoker1' } }));
  }

  /** speakingStart through the harness + ≥20 qualifying packets (gate floor). */
  function speak(userId = 'u1') {
    speakHandlers.start?.(userId);
    const rec = ctrl.debugSession()?.recorder;
    for (let i = 0; i < 20; i++) rec?.packet(userId);
  }

  /** speakingEnd through the harness (the gate's silence window starts here). */
  function endSpeaking(userId = 'u1') {
    speakHandlers.end?.(userId);
  }

  return {
    ctrl,
    controller: ctrl,
    start,
    masterStartArgs,
    speak,
    endSpeaking,
    ctrlStop: (i = mockInteraction()) => ctrl.stop(i),
  };
}

describe('always-BOTH start: master.start() receives the recorder-reported clock read', () => {
  it('the shared-zero invariant survives the sidecar deletion', async () => {
    // The bot still reads the clock once and hands the recorder-reported
    // startedAtMs to master.start() (t0).
    const shift = 765; // deliberately NOT a friendly multiple of 20 ms
    const h = gateHarness({ master: true, recorderStartShiftMs: shift });
    await h.start();
    assert.equal(h.masterStartArgs.length, 1, 'master.start called exactly once');
    assert.equal(h.masterStartArgs[0], HARNESS_T0 + shift, 'master.start got the recorder clock read');
    await h.ctrlStop();
  });
});

describe('SpeakingGate real-timer path at the bot level (v3.0.0 Task 6 re-pin)', () => {
  it("the gate's DEFAULT setTimeout/clearTimeout still closes a window (short real timers)", async () => {
    // Task 3 deleted the only bot-level case that exercised the gate's real
    // (unopted-out) timers; it asserted on sidecar appends, which can no
    // longer happen. Re-pinned against a surviving observable — the
    // `stopped speaking` logEvent (console-backed, src/log.js) — with REAL
    // timers in the tens of ms, so the default TimerRef path is exercised
    // without a multi-second sleep.
    const h = gateHarness({ master: true, realTimers: true, confirmMs: 30, silenceMs: 30 });
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await h.start();
      h.speak('u1'); // speakingStart + 20 packets ...
      await sleep(200); // ... real confirmMs (30ms) elapses → onConfirmed (~6.7x margin)
      h.endSpeaking('u1');
      await sleep(200); // ... real silenceMs (30ms) elapses → onStopped (~6.7x margin)
    } finally {
      console.log = orig;
    }
    assert.ok(
      lines.some((l) => /Alice started speaking/.test(l)),
      `expected a real-timer started line; got: ${lines.join(' | ')}`,
    );
    assert.ok(
      lines.some((l) => /Alice stopped speaking/.test(l)),
      `expected a real-timer stopped line; got: ${lines.join(' | ')}`,
    );
    await h.ctrlStop();
  });

  it('SPEAKING_DEFAULTS.confirmMs/silenceMs are pinned (a window regression stays visible)', () => {
    // Production runs on these defaults, but every deterministic case injects
    // its own windows and the real-timer case above injects 30 ms — so a
    // mutated default would slip through the whole suite. Pin the two windows
    // the bot's confirm/silence behaviour actually depends on.
    assert.equal(SPEAKING_DEFAULTS.confirmMs, 1000);
    assert.equal(SPEAKING_DEFAULTS.silenceMs, 1000);
  });
});

// --- per-user combined render has no labels path (v3.0.0 Task 4) ---
// The master transcription route is gone, and with it the attribution /
// speaking-log label path that fed it. A per-user session renders through
// renderCombinedTranscriptMarkdown from track.startedAtMs only. This negative
// pin is repurposed off the shared speaking harness so no suite still
// depends on it (Task 6 deletes the sidecar modules themselves).

describe('per-user combined render has no labels path (negative pin)', () => {
  function combinedInlineHarness() {
    const writes = [];
    const dmCalls = [];
    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: createMapConfigStore({
        transcribeEnabled: true,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 180,
      }),
      createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: () => ({
        start: () => ({ dir: 'C:\\meetings\\x' }),
        addUser() {},
        removeUser() {},
        stop: () => ({
          dir: 'C:\\meetings\\x',
          files: [],
          userFiles: [
            { path: 'C:\\meetings\\x\\Alice-u1.ogg', displayName: 'Alice', startedAtMs: 0, frames: 200, speechFrames: 200 },
          ],
          startedAtMs: 0,
        }),
      }),
      deliver: async () => ({ delivered: true }),
      transcribe: async (args) => ({
        segments: [{ start: 1, end: 2, text: `hi ${args.masterPath}` }],
        language: 'en',
      }),
      transcribeDM: async (id, payload) => {
        dmCalls.push({ id, payload });
      },
      transcribeWriteFile: (path, data) => {
        writes.push({ path, data });
        return Promise.resolve();
      },
    });
    return { controller, writes, dmCalls };
  }

  it('combined sessions render through renderCombinedTranscriptMarkdown with no labels key', async () => {
    const { controller, writes, dmCalls } = combinedInlineHarness();
    await controller.record(mockInteraction());
    await controller.stop(mockInteraction());
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /transcript-.*\.md$/, 'combined doc named from the session stamp');
    // Cheap shape pin: the combined line format is `[mm:ss] **Name:** text` via
    // renderCombinedTranscriptMarkdown — derived from track.startedAtMs, NOT
    // from any labels array (the attribution path no longer exists).
    assert.match(writes[0].data, /\[00:01\] \*\*Alice:\*\* hi /);
    assert.equal(dmCalls.length, 1);
  });
});


// --- default createRecorder wiring (v3.0.0 Task 2) ---
// Every other suite in this file injects a fake createRecorder, so the DEFAULT
// wrapper in src/bot.js — the only production path that constructs a real
// Recorder — is otherwise exercised by no test at all. This pins that the
// wrapper forwards `guildId` from the /record interaction into `new Recorder`:
// delete that one forwarded field and every real session calls
// sessionDir(root, startedAt, undefined) and throws mid-/record.
describe('default createRecorder wiring (real Recorder, per-guild session dir)', () => {
  // Realistic 18-digit Discord snowflake; the fake interactions elsewhere use
  // the non-snowflake 'g1' that sessionDir would reject.
  const GUILD_ID = '123456789012345678';
  const roots = [];

  after(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Controller with the DEFAULT createRecorder (deliberately NOT injected) and
   * a throwaway meetingsRoot. No user ever joins, so the real Recorder's
   * `subscribe` (connection.receiver.subscribe) is never called — the stub
   * connection only needs a speaking EventEmitter and destroy().
   */
  function realRecorderController() {
    const meetingsRoot = mkdtempSync(join(tmpdir(), 'dmr-default-rec-'));
    roots.push(meetingsRoot);
    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot,
      configStore: createMapConfigStore({
        transcribeEnabled: false,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 180,
      }),
      // Keep the test loop clean: no real auto-stop interval is scheduled.
      setIntervalFn: () => 7,
      clearIntervalFn: () => {},
      joinVoice: async () => ({
        receiver: {
          speaking: new EventEmitter(),
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      // createRecorder intentionally omitted: the real default wrapper runs.
    });
    return { controller, meetingsRoot };
  }

  it('forwards interaction.guildId into the real session directory path', async () => {
    const { controller, meetingsRoot } = realRecorderController();
    const interaction = mockInteraction({ guildId: GUILD_ID });

    await controller.record(interaction);

    const session = controller.debugSession();
    assert.ok(session, 'session started through the real Recorder path');
    assert.equal(session.guildId, GUILD_ID);

    const dir = session.recorder.dir;
    // The guild segment is the forwarded id, NOT 'undefined' — this is the
    // assertion that fails if the wrapper drops its `guildId` forwarding.
    assert.ok(
      dir.includes(join('discord-meetings', GUILD_ID)),
      `session dir nests under the guild id: ${dir}`,
    );
    assert.equal(
      dir,
      join(
        meetingsRoot,
        'discord-meetings',
        GUILD_ID,
        dir.split(/[\\/]/).pop(),
      ),
    );
    assert.ok(existsSync(dir), `session directory created on disk: ${dir}`);
    assert.ok(existsSync(join(meetingsRoot, 'discord-meetings', GUILD_ID)));
  });
});

// --- master-only delivery + transcript DM gate (v3.0.0 Task 7 / Task 7b) ---
// The bot-level pieces Task 7 owns: the delivery call's payload shape
// (`userFiles` for the emptiness check only, `masterFile` the only thing that
// may be sent), the suppressed tail, the failed-master-write reply/tail
// agreement, the `/dm transcribe` gate, and — the important one — the
// gate → recorder.markConfirmed → finalize chain that decides whether ANY
// per-user track is kept. A reviewer mutated the gate's `onConfirmed` to a
// no-op and the whole suite stayed green because every other bot-level test
// injects a recorder stub whose `markConfirmed` does nothing. Task 7b hardens
// the pin: the composition case now drives the REAL `Recorder` (subscribe/mux
// seams only), so a change to `Recorder#finalize`'s confirmed gate is caught
// too — mutating `onConfirmed` now fails through production recorder code.
// The deterministic gate cases drive the fake timer pair; the one case that
// exercises the DEFAULT timers uses a >=5x real-timer margin.
describe('master-only delivery + transcript DM gate (v3.0.0 Task 7)', () => {
  const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
  const DIR = 'C:\\meetings\\x';
  const MASTER = 'C:\\meetings\\x\\master-2026-09-19_12-00.ogg';

  /** Real-Recorder temp roots, cleaned up when this describe ends. */
  const tmpRoots = [];
  after(() => {
    for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  });

  /**
   * Hardened gate pin (Task 7b): a controller whose `createRecorder` builds a
   * REAL `Recorder`, with only its `subscribe`/`mux` seams injected, so the
   * whole chain `gate.onConfirmed → recorder.markConfirmed → Recorder#finalize`'s
   * confirmed gate is production code. The original Task 7 case mirrored that
   * gate by hand in a stub, so a change to the real finalize gate would not be
   * caught (proved by mutating bot.js's `onConfirmed`).
   */
  function realRecorderHarness(opts = {}) {
    const GUILD_ID = '123456789012345678';
    const meetingsRoot = mkdtempSync(join(tmpdir(), 'dmr-task7b-rec-'));
    tmpRoots.push(meetingsRoot);
    const deliverCalls = [];
    const speakHandlers = {};
    /** @type {Map<string, PassThrough>} userId → the stream the recorder subscribed to */
    const streams = new Map();
    /** @type {Recorder | null} the REAL Recorder this harness builds */
    let recorder = null;

    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot,
      configStore: createMapConfigStore({
        transcribeEnabled: false,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 180,
      }),
      setIntervalFn: () => 7,
      clearIntervalFn: () => {},
      joinVoice: async () => ({
        receiver: {
          speaking: {
            on(ev, fn) {
              speakHandlers[ev] = fn;
            },
          },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: (recOpts) =>
        (recorder = new Recorder({
          ...recOpts,
          // Seams only — no real opus mux (ffmpeg) and no real voice stream.
          // Everything else (addUser, markConfirmed, #finalize) is production.
          mux: () => Buffer.from('fake-ogg'),
          subscribe: (userId) => {
            const s = new PassThrough();
            streams.set(userId, s);
            return s;
          },
        })),
      createMasterMix: () => ({ start() {}, push() {}, finalize: async () => null }),
      deliver: async (args) => {
        deliverCalls.push(args);
        return { delivered: true };
      },
      notifyChannel: async () => {},
      gateTimers: opts.gateTimers ?? {},
    });

    return {
      GUILD_ID,
      controller,
      deliverCalls,
      /** The REAL recorder under test (its `users` map is the "who reached the
       * recorder" probe the compose case pins). */
      get recorder() {
        return recorder;
      },
      /**
       * speakingStart, then `n` activity packets the REAL recorder receives
       * through its subscribed stream (→ frames + onPacket). Drains the
       * microtask queue so the packets are counted before any gate timer fires.
       */
      async speak(userId, n = 150) {
        speakHandlers.start?.(userId);
        const s = streams.get(userId);
        for (let i = 0; i < n; i++) s?.write(Buffer.alloc(60));
        for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      },
      /** speakingEnd (drop the broadcast flag) without a confirmation window. */
      endSpeaking(userId) {
        speakHandlers.end?.(userId);
      },
    };
  }

  /**
   * Task 7 harness. Two shapes matter:
   * - the master `finalize` stub resolves a REAL path (the shared `makeHarness`
   *   stub resolves null, so no master-path case could ever be pinned with it);
   *   `master: null` is the failed-write case.
   * - the recorder stub ACTUALLY records confirmations and applies a confirmed
   *   gate of its own, so "no markConfirmed" is observable as an empty
   *   `userFiles` instead of passing silently. (The real `Recorder#finalize` no
   *   longer discards unconfirmed tracks since v3.0.2 D3; this stub keeps the
   *   old shape for these delivery-matrix tests.)
   */
  function task7Harness(opts = {}) {
    const deliverCalls = [];
    const notices = [];
    const writes = [];
    const dmCalls = [];
    const speakHandlers = {};
    let masterPackets = 0;
    /** @type {any} */
    let rec = null;

    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: createMapConfigStore({
        transcribeEnabled: true,
        dmAudioEnabled: opts.dmAudioEnabled ?? true,
        dmTranscribeEnabled: opts.dmTranscribeEnabled ?? true,
        autostopMinutes: 180,
      }),
      now: () => new Date(T0),
      setIntervalFn: () => 7,
      clearIntervalFn: () => {},
      joinVoice: async () => ({
        receiver: {
          speaking: {
            on(ev, fn) {
              speakHandlers[ev] = fn;
            },
          },
          subscribe: () => ({ on() {}, destroy() {} }),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: (recOpts) => {
        /** id → {displayName, frames, confirmed}: the real Recorder's bookkeeping. */
        const users = new Map();
        rec = {
          opts: recOpts,
          users,
          start: () => ({ dir: DIR, startedAtMs: T0 }),
          addUser({ id, displayName }) {
            users.set(id, { displayName, frames: 0, confirmed: false });
          },
          markConfirmed(id) {
            const u = users.get(id);
            if (u) u.confirmed = true;
          },
          removeUser() {},
          stop() {
            const userFiles = [];
            for (const [id, u] of users) {
              // Recorder#finalize: an unconfirmed (or empty) entry is never kept.
              if (!u.confirmed || u.frames === 0) continue;
              userFiles.push({
                path: `${DIR}\\${u.displayName}-${id}.ogg`,
                displayName: u.displayName,
                startedAtMs: T0,
                frames: u.frames,
                speechFrames: u.frames,
              });
            }
            return {
              dir: DIR,
              files: userFiles.map((f) => f.path),
              userFiles,
              startedAtMs: T0,
            };
          },
        };
        rec.packet = (userId, bytes = 60) => {
          const u = users.get(userId);
          if (u) u.frames += 1;
          recOpts.onPacket(userId, Buffer.alloc(bytes));
        };
        return rec;
      },
      createMasterMix: () => ({
        packetCount: 0,
        start() {},
        push() {
          this.packetCount += 1;
          masterPackets += 1;
        },
        finalize: async () => (opts.master === undefined ? MASTER : opts.master),
      }),
      deliver: async (args) => {
        deliverCalls.push(args);
        // `realDeliver` runs the production deliverSession so the DM reply and
        // the channel tail can be asserted together (the split-brain pin);
        // otherwise deliver's own suite pins its flag matrix and the controller
        // branches on `suppressed` (rule 2) vs a hard failure.
        if (opts.realDeliver) return deliverSession(args);
        if (args.sendAudio === false) return { delivered: false, suppressed: true };
        return { delivered: true };
      },
      notifyChannel: async (_channelId, t) => notices.push(t),
      transcribe: async () => ({
        segments: [{ start: 1, end: 2, text: 'hi' }],
        language: 'en',
      }),
      transcribeDM: async (id, payload) => dmCalls.push({ id, payload }),
      transcribeOpts: { model: 'base' },
      transcribeWriteFile: (p, d) => {
        writes.push({ path: p, data: d });
        return Promise.resolve();
      },
      gateTimers: opts.gateTimers ?? {},
    });

    return {
      controller,
      deliverCalls,
      notices,
      writes,
      dmCalls,
      masterPackets: () => masterPackets,
      /** speakingStart + the gate's activity floor for `userId` */
      speak(userId) {
        speakHandlers.start?.(userId);
        // 150 > MIN_TRACK_FRAMES (100), so the track also survives the
        // stop-time near-empty skip and can reach transcription.
        for (let i = 0; i < 150; i++) rec?.packet(userId);
      },
      /** speakingEnd (the broadcast flag drops) without a confirmation window */
      endSpeaking(userId) {
        speakHandlers.end?.(userId);
      },
      /** audio packets only: the master hears audio, no track is confirmed */
      silentPackets(userId, n = 20) {
        for (let i = 0; i < n; i++) rec?.packet(userId, 40);
      },
    };
  }

  /** Let the fire-and-forget transcription IIFE finish. */
  async function settle(pred, tries = 400) {
    for (let i = 0; i < tries; i++) {
      if (pred()) return;
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Run fn with console.log captured; returns the collected lines. */
  async function withLogs(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return lines;
  }

  it('gate composition (REAL Recorder): onConfirmed -> markConfirmed is log-only: both the confirmed and the unconfirmed track survive finalize', async () => {
    // Deterministic by construction: the fake timer pair below means the gate's
    // confirm window elapses on `timers.fire()`, never on wall-clock time
    // (Task 7b killed the residual real-timer slack). The recorder is the REAL
    // Recorder with only its subscribe/mux seams injected, so
    // the gate -> markConfirmed chain is production code under test.
    const timers = fakeGateTimers();
    const h = realRecorderHarness({ gateTimers: timers });
    await h.controller.record(mockInteraction({ guildId: h.GUILD_ID }));

    // Alice: sustained speech through the gate -> onConfirmed -> markConfirmed.
    await h.speak('u1');
    // Bob: the flag flickers, then speakingEnd clears the confirm timer before
    // it can fire -> never confirmed -> his track is still kept (gate is log-only).
    await h.speak('u2');

    // The pin the Task 7 rewrite dropped: BOTH speakers actually reached the
    // recorder, each with audio frames. Without it "only the confirmed one
    // survives finalize" is unfalsifiable — a harness that never fed Bob would
    // pass just as well.
    assert.deepEqual(
      [...h.recorder.users.keys()].sort(),
      ['u1', 'u2'],
      'both speakers reached the recorder',
    );
    for (const [id, u] of h.recorder.users) {
      assert.ok(u.frames.length > 0, `${id} delivered audio frames to the recorder`);
    }

    h.endSpeaking('u2');

    assert.equal(timers.armed(), 1, 'only the confirmed speaker has an armed gate timer');
    timers.fire(); // the confirm window elapses -> onConfirmed -> recorder.markConfirmed('u1')

    await h.controller.stop(mockInteraction({ guildId: h.GUILD_ID }));
    await settle(() => h.deliverCalls.length > 0);

    assert.equal(h.deliverCalls.length, 1);
    const call = h.deliverCalls[0];
    // THE CONSEQUENCE (v3.0.2 D3): the gate is log-only, so BOTH speakers'
    // tracks survive the REAL Recorder's `#finalize`.
    assert.deepEqual(
      call.userFiles.map((f) => f.displayName).sort(),
      ['Alice', 'Bob'],
      `every speaker keeps a track: ${JSON.stringify(call.userFiles)}`,
    );
    assert.equal(call.userFiles.length, 2);
    assert.ok(
      call.userFiles.some((f) => f.path.includes('Bob')),
      'the unconfirmed speaker keeps a track',
    );
    // userFiles is an emptiness/consistency input, never a delivery payload.
    assert.equal(call.files, undefined, 'tracks are never handed to the sender');
  });

  it('a suppressed audio DM (.dm audio FALSE) tails with "Files kept on disk", never "Delivery failed"', async () => {
    const h = task7Harness({ dmAudioEnabled: false });
    await h.controller.record(mockInteraction());
    await h.controller.stop(mockInteraction());
    await settle(() => h.notices.length > 1); // start notice + stop notice

    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].sendAudio, false, 'the /dm audio toggle reaches deliver');
    assert.equal(h.deliverCalls[0].masterFile, MASTER);
    const notice = h.notices.at(-1);
    assert.match(notice, /Files kept on disk \(audio DMs are off\)\./);
    assert.doesNotMatch(notice, /Delivery failed/i);
    assert.doesNotMatch(notice, /sent to your DMs/i);
  });

  it('a failed master write gets its own tail — never "nobody spoke"', async () => {
    // finalize() resolves null AFTER logging a real failure (the 186b95d
    // contract) while the master mix heard audio: that combination is a write
    // failure, not a silent session.
    const h = task7Harness({ master: null });
    await h.controller.record(mockInteraction());
    h.silentPackets('u1');
    assert.ok(h.masterPackets() > 0, 'the master mix received audio');
    await h.controller.stop(mockInteraction());
    await settle(() => h.notices.length > 1); // start notice + stop notice

    // The truth reaches deliver too: the bot hands over "the mix heard audio"
    // so deliver's rule (1) cannot answer "nobody spoke" (see the realDeliver
    // agreement case below and deliver.test.mjs).
    assert.equal(
      h.deliverCalls[0].masterHadAudio,
      true,
      'the bot tells deliver the mix heard audio',
    );
    const notice = h.notices.at(-1);
    assert.match(notice, /The master mix could not be written — see the log\. Files are at:/);
    assert.ok(notice.includes(DIR), 'the tail names the on-disk path');
    assert.doesNotMatch(notice, /nobody spoke/i);
  });

  it('failed master write after audio: the DM reply and the channel tail agree (never "nobody spoke")', async () => {
    // The split-brain pin, end to end: `realDeliver` runs the production
    // deliverSession over the same args the controller passes, so BOTH
    // user-facing messages for this one session are asserted together. They
    // came from different modules and disagreed before the fix.
    const h = task7Harness({ master: null, realDeliver: true });
    const interaction = mockInteraction();
    await h.controller.record(interaction);
    h.silentPackets('u1');
    assert.ok(h.masterPackets() > 0, 'the master mix received audio');
    await h.controller.stop(interaction);
    await settle(() => h.notices.length > 1); // deliver's edit + the stop notice

    assert.equal(h.deliverCalls[0].masterHadAudio, true);
    const dmReply = String(interaction._replies.at(-1)?.content ?? interaction._replies.at(-1) ?? '');
    assert.match(dmReply, /The master mix could not be written — see the log\./);
    assert.ok(dmReply.includes(DIR));
    assert.doesNotMatch(dmReply, /nobody spoke/i);

    const notice = h.notices.at(-1);
    assert.match(notice, /The master mix could not be written — see the log\./);
    assert.doesNotMatch(notice, /nobody spoke/i);
  });

  it('a genuinely silent session still says nobody spoke', async () => {
    const h = task7Harness({ master: null }); // no packets at all
    await h.controller.record(mockInteraction());
    assert.equal(h.masterPackets(), 0);
    await h.controller.stop(mockInteraction());
    await settle(() => h.notices.length > 1); // start notice + stop notice

    assert.equal(
      h.deliverCalls[0].masterHadAudio,
      false,
      'a genuinely silent session reaches deliver without the audio-heard hint',
    );
    const notice = h.notices.at(-1);
    assert.match(notice, /No audio was captured — nobody spoke\./);
    assert.doesNotMatch(notice, /master mix could not be written/i);
  });

  it('/dm transcribe FALSE: the transcript is still written, never DM\'d, and the log says so', async () => {
    const timers = fakeGateTimers();
    const h = task7Harness({
      dmTranscribeEnabled: false,
      gateTimers: timers,
    });
    const lines = await withLogs(async () => {
      await h.controller.record(mockInteraction());
      h.speak('u1');
      timers.fire(); // deterministic: the confirm window is ours, not the clock
      await h.controller.stop(mockInteraction());
      await settle(() => h.writes.length > 0);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    });

    assert.equal(h.writes.length, 1, 'the file is produced regardless of the DM toggle');
    assert.match(h.writes[0].path, /transcript-.*\.md$/);
    assert.equal(h.dmCalls.length, 0, 'no transcript DM with the toggle off');
    const written = lines.filter((l) => l.includes('transcript written'));
    assert.equal(written.length, 1, `expected the DM-off log line: ${lines.join(' | ')}`);
    assert.match(
      written[0],
      /transcript written → transcript-.*\.md \(DM off via \/dm transcribe FALSE\)/,
    );
    assert.equal(lines.filter((l) => l.includes('transcript delivered')).length, 0);
  });

  it('/dm transcribe TRUE (default): the same transcript IS DM\'d', async () => {
    const timers = fakeGateTimers();
    const h = task7Harness({ gateTimers: timers });
    const lines = await withLogs(async () => {
      await h.controller.record(mockInteraction());
      h.speak('u1');
      timers.fire(); // deterministic: the confirm window is ours, not the clock
      await h.controller.stop(mockInteraction());
      await settle(() => h.dmCalls.length > 0);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    });

    assert.equal(h.writes.length, 1);
    assert.equal(h.dmCalls.length, 1);
    assert.equal(h.dmCalls[0].payload.content, 'Your meeting transcript:');
    assert.match(lines.join(' | '), /transcript delivered → transcript-.*\.md/);
  });
});

