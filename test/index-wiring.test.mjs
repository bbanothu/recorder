import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { commandData, createSessionController } from '../src/bot.js';
import { createConfigStore } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import {
  wireGuildLedger,
  wireInteractionDispatch,
  DISPATCH_HANDLERS,
  ensureNodeSqliteSupport,
  buildSeedDefaults,
} from '../src/wiring.js';

function seedDefaults() {
  return {
    transcribeEnabled: true,
    dmAudioEnabled: true,
    dmTranscribeEnabled: true,
    autostopMinutes: 5,
  };
}

/** Minimal headless client that records event registrations. */
function fakeClient() {
  const handlers = new Map();
  return {
    handlers,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return this;
    },
    /** Fire every registered listener for an event (GuildCreate bursts do this). */
    emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      for (const fn of list) fn(...args);
      return list.length;
    },
  };
}

function fakeDeployer() {
  const calls = [];
  const forgetCalls = [];
  const deploy = (guildId) => calls.push(guildId);
  deploy.forget = (guildId) => forgetCalls.push(guildId);
  return { deploy, calls, forgetCalls };
}

describe('GuildCreate/GuildDelete ledger wiring', () => {
  it('GuildCreate upserts the ledger row exactly once per event', () => {
    const client = fakeClient();
    const calls = [];
    const store = { upsertGuild: (id) => calls.push(id) };
    const deployer = fakeDeployer();
    wireGuildLedger({ client, configStore: store, deployGuildCommands: deployer.deploy });
    client.emit('guildCreate', { id: 'g1' });
    client.emit('guildCreate', { id: 'g2' });
    assert.deepEqual(calls, ['g1', 'g2'], 'one upsert per guild event');
    assert.deepEqual(deployer.calls, ['g1', 'g2'], 'deploy still runs');
  });

  it('a reconnect burst does not inflate rejoinCount (gap math lives in the store)', () => {
    const client = fakeClient();
    const db = new DatabaseSync(':memory:');
    let t = new Date('2026-09-21T00:00:00Z');
    const realStore = createConfigStore(db, {
      seedDefaults: seedDefaults(),
      now: () => t,
    });
    const deployer = fakeDeployer();
    wireGuildLedger({ client, configStore: realStore, deployGuildCommands: deployer.deploy });
    // One minute apart x5: all inside the 10-minute rejoin gap → count stays 0.
    for (let i = 0; i < 5; i++) {
      client.emit('guildCreate', { id: 'g1' });
      t = new Date(t.getTime() + 60_000);
    }
    const [row] = realStore.listGuilds();
    assert.equal(row.rejoinCount, 0, 'burst inside rejoin gap never inflates rejoinCount');
    assert.equal(row.joinedAt, '2026-09-21T00:00:00.000Z', 'joinedAt from first contact');
  });

  it('GuildDelete still calls deployGuildCommands.forget and never touches the ledger', () => {
    const client = fakeClient();
    const forgotten = [];
    const store = {
      upsertGuild: () => assert.fail('GuildDelete must not touch the ledger'),
    };
    const deployer = (id) => assert.fail(`GuildDelete must not deploy (got ${id})`);
    deployer.forget = (id) => forgotten.push(id);
    wireGuildLedger({ client, configStore: store, deployGuildCommands: deployer });
    client.emit('guildDelete', { id: 'g1' });
    assert.deepEqual(forgotten, ['g1']);
  });

  it('a throwing upsertGuild is caught inside the GuildCreate listener', () => {
    // A SQLite throw inside a gateway callback must not become an uncaught
    // exception: the listener absorbs it and logs loudly instead.
    const client = fakeClient();
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      wireGuildLedger({
        client,
        configStore: { upsertGuild: () => { throw new Error('SQLITE_BUSY: database is locked'); } },
        deployGuildCommands: fakeDeployer().deploy,
      });
      assert.doesNotThrow(() => client.emit('guildCreate', { id: 'g-throwing' }));
    } finally {
      console.error = origError;
    }
    assert.equal(errors.length, 1, 'exactly one loud console.error');
    assert.match(String(errors[0]), /g-throwing/, 'error message includes the guild id');
  });
});

describe('interaction dispatch covers every commandData name (Task 3 gap pin)', () => {
  it('the dispatch map has an entry for every registered command', () => {
    const names = commandData.map((c) => c.name).sort();
    assert.deepEqual(Object.keys(DISPATCH_HANDLERS).sort(), names);
  });

  it('the removed /record_type has no registry or dispatch entry any more', () => {
    assert.equal(commandData.find((c) => c.name === 'record_type'), undefined);
    assert.equal(DISPATCH_HANDLERS.record_type, undefined);
    assert.equal(DISPATCH_HANDLERS.dm, 'dm', '/dm owns the delivery-settings dispatch');
  });

  it('dispatches by commandName to the right handler', async () => {
    const calls = [];
    const controller = new Proxy({}, {
      get(target, prop) {
        if (!target[prop]) target[prop] = async () => calls.push(prop);
        return target[prop];
      },
    });
    const store = {};
    for (const name of commandData.map((c) => c.name)) {
      const interaction = {
        commandName: name,
        isChatInputCommand: () => true,
        guildId: 'g1',
        options: { getString: () => null, getInteger: () => null },
        reply: async () => {},
      };
      await wireInteractionDispatch({ interaction, controller, configStore: store });
    }
    assert.deepEqual(
      calls,
      commandData.map((c) => DISPATCH_HANDLERS[c.name]),
      'each command name routes to its dedicated handler',
    );
  });

  it('an unknown (removed) command gets a loud reply instead of silent no-op', async () => {
    const calls = [];
    const controller = { record: async () => calls.push('record') };
    const replies = [];
    const interaction = {
      commandName: 'singlefile', // removed in 2.0.0
      isChatInputCommand: () => true,
      options: { getString: () => null, getInteger: () => null },
      reply: async (p) => replies.push(p),
    };
    await wireInteractionDispatch({ interaction, controller, configStore: {} });
    assert.deepEqual(calls, [], 'unknown command dispatches nothing');
    assert.ok(replies[0], 'unknown command answers the user');
  });

  it('a removed /record_type dispatch answers with the 3.0.0 removal notice', async () => {
    const replies = [];
    const interaction = {
      commandName: 'record_type', // removed in 3.0.0
      isChatInputCommand: () => true,
      options: { getString: () => null, getInteger: () => null },
      reply: async (p) => replies.push(p),
    };
    await wireInteractionDispatch({
      interaction,
      controller: { record: async () => {} },
      configStore: {},
    });
    assert.ok(replies[0], 'the removed command answers the user');
    assert.match(replies[0].content, /record_type/);
    assert.match(replies[0].content, /removed in 3\.0\.0/);
  });

  it('the /record_type removal tip is gated: an unrelated unknown command gets no tip', async () => {
    // Carry-in (i): the tip used to be appended to EVERY unknown command, so a
    // typo like `/recrod` answered with a /record_type removal notice.
    const replies = [];
    const interaction = {
      commandName: 'recrod', // typo of /record — unrelated to the removal
      isChatInputCommand: () => true,
      options: { getString: () => null, getInteger: () => null },
      reply: async (p) => replies.push(p),
    };
    await wireInteractionDispatch({
      interaction,
      controller: { record: async () => {} },
      configStore: {},
    });
    assert.equal(replies.length, 1, 'unknown command still answers');
    assert.match(replies[0].content, /Unknown command/);
    assert.doesNotMatch(replies[0].content, /record_type/);
    assert.doesNotMatch(replies[0].content, /removed in 3\.0\.0/);
  });

  it('a non-chat-input interaction skips dispatch entirely (no reply, no handler)', async () => {
    const calls = [];
    const controller = new Proxy({}, {
      get(target, prop) {
        if (!target[prop]) target[prop] = async () => calls.push(prop);
        return target[prop];
      },
    });
    const replies = [];
    // e.g. an autocomplete interaction: has commandName but isChatInputCommand() → false
    const interaction = {
      commandName: 'record',
      isChatInputCommand: () => false,
      reply: async (p) => replies.push(p),
    };
    await wireInteractionDispatch({ interaction, controller, configStore: {} });
    assert.deepEqual(calls, [], 'non-chat-input interaction dispatches nothing');
    assert.deepEqual(replies, [], 'non-chat-input interaction never gets the unknown-command reply');
  });
});

describe('controller receives the shared SQLite store (round-trip)', () => {
  it('the shared store reaches the controller: a later /record is always-BOTH', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createConfigStore(db, {
      seedDefaults: seedDefaults(),
      now: () => new Date('2026-09-21T01:00:00Z'),
    });
    let lastRecorderOpts = null;
    const controller = createSessionController({
      botUserId: 'bot1',
      meetingsRoot: 'C:\\meetings',
      configStore: store,
      joinVoice: async () => ({
        receiver: {
          speaking: { on() {} },
          subscribe: () => ({}),
          subscriptions: new Map(),
        },
        destroy() {},
      }),
      createRecorder: (opts) => {
        lastRecorderOpts = opts;
        return {
          start: () => ({ dir: 'C:\\meetings\\x' }),
          addUser() {},
          removeUser() {},
          stop: () => ({ dir: 'C:\\meetings\\x', files: [] }),
        };
      },
      deliver: async () => ({ delivered: true }),
      notifyChannel: null,
      now: () => new Date('2026-09-21T01:00:00Z'),
    });

    // Command round: /dm audio FALSE in guild g1 through the SAME SQLite store
    // the controller holds. The write must be observable ON the store — a
    // store-independent assertion would pass with any store at all, which is
    // exactly the Task 3 gap this re-pin closes.
    const dm = {
      guildId: 'g1',
      user: { id: 'u9', username: 'T' },
      options: { getString: (n) => (n === 'audio' ? 'FALSE' : null) },
      _replies: [],
      async reply(p) { this._replies.push(p); return p; },
    };
    await controller.dm(dm);
    assert.equal(store.getConfig('g1').dmAudioEnabled, false, '/dm reached the shared store');
    assert.equal(store.getConfig('g2').dmAudioEnabled, true, 'no cross-guild leak');

    // A later /record in the SAME guild records BOTH artifacts regardless.
    await controller.record({
      guildId: 'g1',
      user: { id: 'invoker1' },
      member: { voice: { channel: { id: 'vc1', name: 'G', guild: { id: 'g1' }, members: new Map() } } },
      guild: { id: 'g1', members: { cache: new Map() }, voiceAdapterCreator: () => ({}) },
      replied: false,
      deferred: false,
      _replies: [],
      async reply(p) { this._replies.push(p); return p; },
      async deferReply() { this.deferred = true; },
      async editReply(p) { this._replies.push(p); return p; },
    });
    assert.equal(lastRecorderOpts.writePerUserFiles, true, 'always-BOTH reached the recorder');
  });
});

describe('ensureNodeSqliteSupport (startup guard)', () => {
  it('passes silently on a supported runtime (this node)', () => {
    assert.doesNotThrow(() => ensureNodeSqliteSupport());
  });
  it('throws loudly naming node:sqlite on Node 22.12 and 21.x', () => {
    for (const v of ['22.12.0', '21.7.3', '18.0.0']) {
      assert.throws(() => ensureNodeSqliteSupport(v), /node:sqlite.*22\.13/s, v);
    }
  });
});

describe('buildSeedDefaults (v3.0.0 Task 5: four-field v2 seed)', () => {
  it('builds the four-field seed from a loadEnv-shaped env (single argument)', () => {
    const seed = buildSeedDefaults({ TRANSCRIBE: false, AUTO_STOP_MINUTES: 7 });
    assert.deepEqual(seed, {
      transcribeEnabled: false,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 7,
    });
  });

  it('the seed carries both dm_* toggles TRUE regardless of TRANSCRIBE', () => {
    const seed = buildSeedDefaults({ TRANSCRIBE: true, AUTO_STOP_MINUTES: 5 });
    assert.equal(seed.dmAudioEnabled, true);
    assert.equal(seed.dmTranscribeEnabled, true);
  });

  it('production seed→store pin: loadEnv → buildSeedDefaults → createConfigStore gives a never-configured guild both dm_* TRUE', () => {
    // The join missing from Task 4: buildSeedDefaults' output is fed verbatim
    // to createConfigStore, and rowToConfig returns that seed for a guild with
    // no row. If the two ends disagree on key names, a bare /dm on a
    // never-configured guild renders audio: FALSE, transcript: FALSE.
    const required = ['DISCORD_BOT_TOKEN', 'MEETINGS_DIR', 'GUILD_IDS', 'TRANSCRIBE', 'AUTO_STOP_MINUTES'];
    const saved = {};
    for (const k of required) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      process.env.DISCORD_BOT_TOKEN = 'tok';
      process.env.MEETINGS_DIR = 'C:\\meetings';
      process.env.GUILD_IDS = '123';
      const env = loadEnv(); // the real production env shape
      const seed = buildSeedDefaults(env); // the real production seed
      const db = new DatabaseSync(':memory:');
      const store = createConfigStore(db, { seedDefaults: seed });
      assert.deepEqual(store.getConfig('123456789012345678'), {
        transcribeEnabled: true,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 5,
      });
    } finally {
      for (const k of required) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('loadEnv DB_PATH', () => {
  const keys = [
    'DISCORD_BOT_TOKEN', 'MEETINGS_DIR', 'GUILD_IDS', 'DB_PATH',
  ];
  let saved;
  let tmp;

  beforeEach(() => {
    saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function setRequired(dir = 'C:\\meetings') {
    process.env.DISCORD_BOT_TOKEN = 'tok';
    process.env.MEETINGS_DIR = dir;
    process.env.GUILD_IDS = '123';
  }

  it('defaults DB_PATH to <MEETINGS_DIR>/recorder.db (path only, no fs write)', () => {
    // A nonexistent MEETINGS_DIR must NOT be created by loadEnv — mkdir is
    // index.js's job at startup. Expected path computed via join so this
    // passes on both win32 and posix (no hardcoded separator style).
    const dir = 'C:\\nonexistent-env-test-xyz\\meetings';
    setRequired(dir);
    assert.equal(loadEnv().DB_PATH, join(dir, 'recorder.db'));
  });

  it('explicit DB_PATH passes through', () => {
    setRequired();
    process.env.DB_PATH = 'D:\\data\\custom.db';
    assert.equal(loadEnv().DB_PATH, 'D:\\data\\custom.db');
  });
});

describe('startup log labels the transcription env value as a SEED (Task 6 nit)', () => {
  it('src/index.js prints the seed, labelled — not as effective state', async () => {
    // index.js has no test seam (importing it logs in a real gateway client
    // and exits), so this pins the SOURCE line by content. The env value is a
    // SEED: /transcribe writes per-guild state, so a guild's effective setting
    // can differ from env.TRANSCRIBE — the old wording ("transcription: on")
    // read as if the log showed the live value. This line had zero coverage.
    const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('Recording: per-user tracks'));
    assert.ok(line, 'the startup line is present');
    assert.match(line, /transcription seed: \$\{env\.TRANSCRIBE \? 'on' : 'off'\}/);
    assert.match(line, /per-guild/);
    assert.doesNotMatch(line, /transcription: /, 'the env seed is not printed as the live value');
  });
});
