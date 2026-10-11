import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, initSchema } from '../src/db.js';
import { AUTO_STOP_MIN_MINUTES, AUTO_STOP_MAX_MINUTES } from '../src/auto-stop.js';

const SEED_DEFAULTS = {
  transcribeEnabled: true,
  dmAudioEnabled: true,
  dmTranscribeEnabled: true,
  autostopMinutes: 5,
};

/** Fresh v2 column set, in the CREATE TABLE order (spec Data model). */
const V2_COLUMNS = [
  'guild_id',
  'transcribe_enabled',
  'dm_audio_enabled',
  'dm_transcribe_enabled',
  'autostop_minutes',
  'updated_at',
];

const GUILDS_TABLE = 'guilds';
const CONFIG_TABLE = 'guild_config';

/** @param {DatabaseSync} db @param {string} table */
function rowCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

/** Column names, prepare-a-pragma form (proven on this runtime). */
function columnNames(db) {
  return db.prepare("PRAGMA table_info('guild_config')").all().map((c) => c.name);
}

describe('createConfigStore', () => {
  /** @type {DatabaseSync} */
  let db;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the store API', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    assert.deepEqual(Object.keys(store).sort(), [
      'getConfig',
      'listGuilds',
      'saveConfig',
      'upsertGuild',
    ]);
    assert.equal(typeof store.getConfig, 'function');
    assert.equal(typeof store.saveConfig, 'function');
    assert.equal(typeof store.upsertGuild, 'function');
    assert.equal(typeof store.listGuilds, 'function');
  });

  it('guild_config is exactly the v2 column set, in CREATE TABLE order', () => {
    assert.deepEqual(columnNames(db), V2_COLUMNS);
  });

  it('getConfig returns seed defaults lazily and does NOT write a row', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    assert.deepEqual(store.getConfig('g1'), SEED_DEFAULTS);
    assert.equal(rowCount(db, CONFIG_TABLE), 0);
    assert.equal(rowCount(db, GUILDS_TABLE), 0);
  });

  it('getConfig on an unknown guild returns the v2 four-field shape', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    assert.deepEqual(store.getConfig('never-seen'), {
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    assert.equal(rowCount(db, CONFIG_TABLE), 0, 'no write-on-read');
  });

  it('saveConfig then getConfig returns the saved field with others at defaults', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    store.saveConfig('g1', { autostopMinutes: 15 });
    assert.deepEqual(store.getConfig('g1'), {
      transcribeEnabled: true,
      dmAudioEnabled: true,
      dmTranscribeEnabled: true,
      autostopMinutes: 15,
    });
  });

  it('saveConfig (dmAudioEnabled) round-trips and leaves the other fields untouched', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    store.saveConfig('g1', { dmAudioEnabled: false });
    assert.deepEqual(store.getConfig('g1'), {
      transcribeEnabled: true,
      dmAudioEnabled: false,
      dmTranscribeEnabled: true,
      autostopMinutes: 5,
    });
    store.saveConfig('g1', { dmTranscribeEnabled: false });
    assert.deepEqual(store.getConfig('g1'), {
      transcribeEnabled: true,
      dmAudioEnabled: false,
      dmTranscribeEnabled: false,
      autostopMinutes: 5,
    });
  });

  it('saveConfig twice for the same guild upserts (1 row, not 2)', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    store.saveConfig('g1', { autostopMinutes: 10 });
    store.saveConfig('g1', { transcribeEnabled: false });
    assert.equal(rowCount(db, CONFIG_TABLE), 1);
    const cfg = store.getConfig('g1');
    assert.equal(cfg.transcribeEnabled, false);
    assert.equal(cfg.autostopMinutes, 10);
  });

  it('getConfig returns independent values for distinct guilds', () => {
    const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
    store.saveConfig('g1', { dmAudioEnabled: false });
    assert.equal(store.getConfig('g2').dmAudioEnabled, true);
    assert.equal(store.getConfig('g1').dmAudioEnabled, false);
  });

  describe('saveConfig validation', () => {
    it('throws on a non-boolean dmAudioEnabled', () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.throws(
        () => store.saveConfig('g1', { dmAudioEnabled: 'nope' }),
        /dmAudioEnabled must be boolean/,
      );
    });

    it('throws on a non-boolean dmTranscribeEnabled', () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.throws(
        () => store.saveConfig('g1', { dmTranscribeEnabled: 'nope' }),
        /dmTranscribeEnabled must be boolean/,
      );
    });

    it(`throws on autostopMinutes below ${AUTO_STOP_MIN_MINUTES} and above ${AUTO_STOP_MAX_MINUTES}`, () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.throws(
        () => store.saveConfig('g1', { autostopMinutes: AUTO_STOP_MIN_MINUTES - 1 }),
        /AUTO_STOP|autostopMinutes/i,
      );
      assert.throws(
        () => store.saveConfig('g1', { autostopMinutes: AUTO_STOP_MAX_MINUTES + 1 }),
        /AUTO_STOP|autostopMinutes/i,
      );
    });

    it('throws before writing anything when the patch is invalid', () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.throws(() => store.saveConfig('g1', { dmAudioEnabled: 'nope' }));
      assert.equal(rowCount(db, GUILDS_TABLE), 0);
      assert.equal(rowCount(db, CONFIG_TABLE), 0);
    });
  });

  describe('upsertGuild rejoin-gap semantics', () => {
    function makeFixedClock(startMs) {
      let t = startMs;
      return {
        now: () => new Date(t),
        advance: (ms) => { t += ms; },
      };
    }

    const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
    const REJOIN_GAP_MS = 10 * 60_000;

    function guildRow(store, id) {
      return store.listGuilds().find((g) => g.guildId === id);
    }

    it('upsertGuild("g1", t0) inserts a ledger row', () => {
      const clock = makeFixedClock(T0);
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS, now: clock.now });
      store.upsertGuild('g1');
      const row = guildRow(store, 'g1');
      assert.ok(row);
      assert.equal(row.rejoinCount, 0);
      assert.equal(row.joinedAt, new Date(T0).toISOString());
      assert.equal(row.lastSeenAt, new Date(T0).toISOString());
    });

    it('a burst inside the 10-minute gap refreshes lastSeenAt but does NOT increment rejoinCount', () => {
      const clock = makeFixedClock(T0);
      const store = createConfigStore(db, {
        seedDefaults: SEED_DEFAULTS,
        now: clock.now,
        rejoinGapMs: REJOIN_GAP_MS,
      });
      store.upsertGuild('g1');
      clock.advance(2 * 60_000);
      store.upsertGuild('g1');
      const row = guildRow(store, 'g1');
      assert.equal(row.rejoinCount, 0);
      assert.equal(row.lastSeenAt, new Date(T0 + 2 * 60_000).toISOString());
      assert.equal(row.joinedAt, new Date(T0).toISOString());
    });

    it('a rejoin beyond the gap increments rejoinCount but preserves joinedAt', () => {
      const clock = makeFixedClock(T0);
      const store = createConfigStore(db, {
        seedDefaults: SEED_DEFAULTS,
        now: clock.now,
        rejoinGapMs: REJOIN_GAP_MS,
      });
      store.upsertGuild('g1');
      clock.advance(30 * 60_000);
      store.upsertGuild('g1');
      const row = guildRow(store, 'g1');
      assert.equal(row.rejoinCount, 1);
      assert.equal(row.joinedAt, new Date(T0).toISOString());
      assert.equal(row.lastSeenAt, new Date(T0 + 30 * 60_000).toISOString());
    });

    it('gap is configurable via rejoinGapMs', () => {
      const clock = makeFixedClock(T0);
      const store = createConfigStore(db, {
        seedDefaults: SEED_DEFAULTS,
        now: clock.now,
        rejoinGapMs: 60_000,
      });
      store.upsertGuild('g1');
      clock.advance(90_000);
      store.upsertGuild('g1');
      assert.equal(guildRow(store, 'g1').rejoinCount, 1);
    });
  });

  describe('listGuilds', () => {
    it('is empty with no rows', () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.deepEqual(store.listGuilds(), []);
    });

    it('returns camelCase rows ordered by joined_at', () => {
      let t = Date.UTC(2026, 8, 21, 12, 0, 0);
      const now = () => new Date(t);
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS, now });
      store.upsertGuild('g2');
      t += 60_000;
      store.upsertGuild('g1');
      store.saveConfig('g9', { autostopMinutes: 15 });
      const rows = store.listGuilds();
      assert.deepEqual(rows.map((r) => r.guildId), ['g2', 'g1', 'g9']);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), [
          'guildId',
          'joinedAt',
          'lastSeenAt',
          'rejoinCount',
        ]);
      }
      assert.equal(rows[0].joinedAt < rows[1].joinedAt, true);
      assert.equal(rows[0].rejoinCount, 0);
    });
  });

  describe('FK safety', () => {
    it('saveConfig without a prior upsertGuild auto-creates the ledger row (0 → 1)', () => {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      assert.equal(rowCount(db, GUILDS_TABLE), 0);
      store.saveConfig('g9', { autostopMinutes: 15 });
      assert.equal(rowCount(db, GUILDS_TABLE), 1);
      assert.equal(rowCount(db, CONFIG_TABLE), 1);
      assert.deepEqual(store.getConfig('g9'), {
        transcribeEnabled: true,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 15,
      });
      const row = store.listGuilds().find((g) => g.guildId === 'g9');
      assert.equal(row.rejoinCount, 0);
    });
  });
});

/**
 * Hand-built legacy v1 DB (pre-3.0.0 columns) with one configured row and
 * user_version = 1. The `guilds` ledger row is inserted only AFTER the guilds
 * table exists (on a fresh DB initSchema creates it).
 */
function legacyV1Db() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE guilds (
      guild_id     TEXT PRIMARY KEY,
      joined_at    TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      rejoin_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE guild_config (
      guild_id            TEXT PRIMARY KEY REFERENCES guilds(guild_id),
      record_type         TEXT NOT NULL,
      transcribe_enabled  INTEGER NOT NULL,
      transcribe_mode     TEXT NOT NULL,
      autostop_minutes    INTEGER NOT NULL,
      updated_at          TEXT NOT NULL
    );

    INSERT INTO guilds (guild_id, joined_at, last_seen_at, rejoin_count)
      VALUES ('g1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 0);

    INSERT INTO guild_config (guild_id, record_type, transcribe_enabled, transcribe_mode, autostop_minutes, updated_at)
      VALUES ('g1', 'MASTER', 0, 'master', 12, '2026-09-01T00:00:00.000Z');

    PRAGMA user_version = 1;
  `);
  return db;
}

describe('v1 -> v2 migration (in place, column-presence guarded)', () => {
  it('migrates a legacy v1 table + row to user_version 2 without losing data', () => {
    const db = legacyV1Db();
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, 'fixture really is v1');
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });

      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      // Order-insensitive: ALTER TABLE ADD COLUMN appends, so a migrated
      // table's column order legitimately differs from the fresh CREATE.
      assert.deepEqual(columnNames(db).sort(), [...V2_COLUMNS].sort());
      assert.equal(columnNames(db).includes('record_type'), false, 'record_type dropped');
      assert.equal(columnNames(db).includes('transcribe_mode'), false, 'transcribe_mode dropped');

      assert.equal(rowCount(db, CONFIG_TABLE), 1, 'the row is preserved, not re-seeded');
      assert.deepEqual(store.getConfig('g1'), {
        transcribeEnabled: false,
        dmAudioEnabled: true,
        dmTranscribeEnabled: true,
        autostopMinutes: 12,
      });
      const raw = db.prepare('SELECT updated_at FROM guild_config WHERE guild_id = ?').get('g1');
      assert.equal(raw.updated_at, '2026-09-01T00:00:00.000Z', 'updated_at preserved byte-for-byte');
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second initSchema leaves the migrated schema untouched', () => {
    const db = legacyV1Db();
    try {
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      store.saveConfig('g1', { dmTranscribeEnabled: false });
      initSchema(db);
      assert.deepEqual(columnNames(db).sort(), [...V2_COLUMNS].sort());
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(store.getConfig('g1').dmTranscribeEnabled, false);
    } finally {
      db.close();
    }
  });
});

describe('initSchema', () => {
  it('sets PRAGMA user_version = 2 on :memory: too', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initSchema(db);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    } finally {
      db.close();
    }
  });

  it('is idempotent (CREATE TABLE IF NOT EXISTS + re-run)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initSchema(db);
      initSchema(db);
      const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
      store.saveConfig('g1', { autostopMinutes: 9 });
      assert.equal(store.getConfig('g1').autostopMinutes, 9);
    } finally {
      db.close();
    }
  });
});

describe('file-backed persistence across restart', () => {
  /** @type {string} */
  let dbPath;
  /** @type {string[]} */
  let sidecars;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `db-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}.sqlite`);
    sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  });

  afterEach(() => {
    for (const f of sidecars) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort cleanup */ }
    }
  });

  it('WAL journal_mode reads back as wal on a file-backed DB', () => {
    const db = new DatabaseSync(dbPath);
    try {
      initSchema(db);
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally {
      db.close();
    }
  });

  it('saved config survives close + reopen with a fresh store', () => {
    {
      const db = new DatabaseSync(dbPath);
      try {
        const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
        store.saveConfig('g1', { autostopMinutes: 15 });
        store.saveConfig('g2', { dmAudioEnabled: false });
        store.upsertGuild('g1');
      } finally {
        db.close();
      }
    }
    {
      const db = new DatabaseSync(dbPath);
      try {
        const store = createConfigStore(db, { seedDefaults: SEED_DEFAULTS });
        assert.deepEqual(store.getConfig('g1'), {
          transcribeEnabled: true,
          dmAudioEnabled: true,
          dmTranscribeEnabled: true,
          autostopMinutes: 15,
        });
        assert.deepEqual(store.getConfig('g2'), {
          transcribeEnabled: true,
          dmAudioEnabled: false,
          dmTranscribeEnabled: true,
          autostopMinutes: 5,
        });
      } finally {
        db.close();
      }
    }
  });
});
