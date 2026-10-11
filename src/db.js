import { DatabaseSync } from 'node:sqlite';

import { AUTO_STOP_MIN_MINUTES, AUTO_STOP_MAX_MINUTES } from './auto-stop.js';

const DEFAULT_REJOIN_GAP_MS = 10 * 60_000;

/**
 * Shared patch-field validation for both config stores. Resolves every field
 * against the current config, then enforces the SAME bounds/types with the
 * SAME error strings in the SQLite and Map stores. Throws before any write
 * touches the store.
 * @param {{
 *   autostopMinutes: number,
 *   transcribeEnabled: boolean,
 *   dmAudioEnabled: boolean,
 *   dmTranscribeEnabled: boolean,
 * }} current
 * @param {{
 *   autostopMinutes?: number,
 *   transcribeEnabled?: boolean,
 *   dmAudioEnabled?: boolean,
 *   dmTranscribeEnabled?: boolean,
 * }} patch
 */
function validatePatchFields(current, patch) {
  const autostopMinutes = patch.autostopMinutes ?? current.autostopMinutes;
  if (
    !Number.isInteger(autostopMinutes)
    || autostopMinutes < AUTO_STOP_MIN_MINUTES
    || autostopMinutes > AUTO_STOP_MAX_MINUTES
  ) {
    throw new Error(
      `autostopMinutes must be an integer ${AUTO_STOP_MIN_MINUTES}-${AUTO_STOP_MAX_MINUTES}, got ${autostopMinutes}`,
    );
  }
  const transcribeEnabled = patch.transcribeEnabled ?? current.transcribeEnabled;
  if (typeof transcribeEnabled !== 'boolean') {
    throw new Error(`transcribeEnabled must be boolean, got ${transcribeEnabled}`);
  }
  const dmAudioEnabled = patch.dmAudioEnabled ?? current.dmAudioEnabled;
  if (typeof dmAudioEnabled !== 'boolean') {
    throw new Error(`dmAudioEnabled must be boolean, got ${dmAudioEnabled}`);
  }
  const dmTranscribeEnabled = patch.dmTranscribeEnabled ?? current.dmTranscribeEnabled;
  if (typeof dmTranscribeEnabled !== 'boolean') {
    throw new Error(`dmTranscribeEnabled must be boolean, got ${dmTranscribeEnabled}`);
  }
  return { autostopMinutes, transcribeEnabled, dmAudioEnabled, dmTranscribeEnabled };
}

/**
 * Create the config-store tables exactly per the spec's data model and migrate
 * an existing v1 DB in place to user_version = 2. Idempotent: the guards are
 * COLUMN-PRESENCE based (never user_version based), so a fresh DB and a legacy
 * DB both converge on the same schema. `node:sqlite` has no `.pragma()` helper,
 * so pragma writes go through `exec` and reads use the prepare form.
 * @param {InstanceType<typeof DatabaseSync>} db
 */
export function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS guilds (
      guild_id     TEXT PRIMARY KEY,
      joined_at    TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      rejoin_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id              TEXT PRIMARY KEY REFERENCES guilds(guild_id),
      transcribe_enabled    INTEGER NOT NULL,
      dm_audio_enabled      INTEGER NOT NULL DEFAULT 1,
      dm_transcribe_enabled INTEGER NOT NULL DEFAULT 1,
      autostop_minutes      INTEGER NOT NULL,
      updated_at            TEXT NOT NULL
    );
  `);

  // v1 -> v2: drop the recording-type/transcription-mode columns, add the two
  // per-guild DM toggles (existing rows materialize them as 1 = send).
  // ALTER TABLE ... DROP COLUMN needs SQLite >= 3.35; the Node >= 22.13 floor
  // bundles >= 3.46.
  const columns = new Set(
    db.prepare("PRAGMA table_info('guild_config')").all().map((c) => c.name),
  );
  if (columns.has('record_type')) db.exec('ALTER TABLE guild_config DROP COLUMN record_type');
  if (columns.has('transcribe_mode')) db.exec('ALTER TABLE guild_config DROP COLUMN transcribe_mode');
  if (!columns.has('dm_audio_enabled')) {
    db.exec('ALTER TABLE guild_config ADD COLUMN dm_audio_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.has('dm_transcribe_enabled')) {
    db.exec('ALTER TABLE guild_config ADD COLUMN dm_transcribe_enabled INTEGER NOT NULL DEFAULT 1');
  }

  db.exec('PRAGMA user_version = 2');
}

/**
 * Build a per-guild configuration store on top of a node:sqlite DatabaseSync.
 *
 * Seed defaults are a lazy read-time fallback: getConfig on a guild with no
 * row returns the seed values and writes nothing. saveConfig validates the
 * patch (src/auto-stop.js bounds plus the shared boolean checks), auto-creates
 * the parent ledger row (INSERT OR IGNORE) so the FK can never reject a first
 * slash-command write, then upserts guild_config.
 *
 * @param {InstanceType<typeof DatabaseSync>} db
 * @param {{
 *   seedDefaults: {
 *     transcribeEnabled: boolean,
 *     dmAudioEnabled: boolean,
 *     dmTranscribeEnabled: boolean,
 *     autostopMinutes: number,
 *   },
 *   now?: () => Date,
 *   rejoinGapMs?: number,
 * }} opts
 */
export function createConfigStore(db, { seedDefaults, now = () => new Date(), rejoinGapMs = DEFAULT_REJOIN_GAP_MS }) {
  initSchema(db);

  const iso = () => now().toISOString();

  const stmtSelectConfig = db.prepare(
    'SELECT transcribe_enabled, dm_audio_enabled, dm_transcribe_enabled, autostop_minutes FROM guild_config WHERE guild_id = ?',
  );
  const stmtEnsureGuild = db.prepare(
    "INSERT OR IGNORE INTO guilds (guild_id, joined_at, last_seen_at, rejoin_count) VALUES (?, ?, ?, 0)",
  );
  const stmtUpsertConfig = db.prepare(`
    INSERT INTO guild_config (guild_id, transcribe_enabled, dm_audio_enabled, dm_transcribe_enabled, autostop_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      transcribe_enabled    = excluded.transcribe_enabled,
      dm_audio_enabled      = excluded.dm_audio_enabled,
      dm_transcribe_enabled = excluded.dm_transcribe_enabled,
      autostop_minutes      = excluded.autostop_minutes,
      updated_at            = excluded.updated_at
  `);
  const stmtSelectGuild = db.prepare(
    'SELECT joined_at, last_seen_at, rejoin_count FROM guilds WHERE guild_id = ?',
  );
  const stmtInsertNewGuild = db.prepare(
    'INSERT INTO guilds (guild_id, joined_at, last_seen_at, rejoin_count) VALUES (?, ?, ?, 0)',
  );
  const stmtRefreshSeen = db.prepare('UPDATE guilds SET last_seen_at = ? WHERE guild_id = ?');
  const stmtBumpRejoin = db.prepare('UPDATE guilds SET last_seen_at = ?, rejoin_count = rejoin_count + 1 WHERE guild_id = ?');
  const stmtListGuilds = db.prepare(
    'SELECT guild_id, joined_at, last_seen_at, rejoin_count FROM guilds ORDER BY joined_at',
  );

  /** @param {Record<string, unknown> | undefined} row */
  function rowToConfig(row) {
    if (!row) return { ...seedDefaults };
    return {
      transcribeEnabled: Boolean(row.transcribe_enabled),
      dmAudioEnabled: Boolean(row.dm_audio_enabled),
      dmTranscribeEnabled: Boolean(row.dm_transcribe_enabled),
      autostopMinutes: row.autostop_minutes,
    };
  }

  /**
   * Per-guild config; missing row → seed defaults, no write-on-read.
   * @param {string} guildId
   */
  function getConfig(guildId) {
    return rowToConfig(stmtSelectConfig.get(guildId));
  }

  /**
   * Validate the patch fields (no duplicated validation logic — the shared
   * validatePatchFields is the single source of truth), upsert the parent
   * ledger row so FK enforcement can never fail a first write, then upsert.
   * @param {string} guildId
   * @param {{
   *   transcribeEnabled?: boolean,
   *   dmAudioEnabled?: boolean,
   *   dmTranscribeEnabled?: boolean,
   *   autostopMinutes?: number,
   * }} patch
   */
  function saveConfig(guildId, patch) {
    // Resolve every field against the current config first so validation
    // throws BEFORE any write touches the ledger.
    const current = rowToConfig(stmtSelectConfig.get(guildId));
    const { autostopMinutes, transcribeEnabled, dmAudioEnabled, dmTranscribeEnabled } =
      validatePatchFields(current, patch);

    const ts = iso();
    stmtEnsureGuild.run(guildId, ts, ts);
    stmtUpsertConfig.run(
      guildId,
      transcribeEnabled ? 1 : 0,
      dmAudioEnabled ? 1 : 0,
      dmTranscribeEnabled ? 1 : 0,
      autostopMinutes,
      ts,
    );
  }

  /**
   * Guild ledger upsert (GuildCreate). Always refreshes last_seen_at;
   * increments rejoin_count only when more than rejoinGapMs (default 10 min)
   * elapsed since the previous last_seen_at (reconnect bursts never inflate).
   * Preserve joined_at from first contact.
   * @param {string} guildId
   */
  function upsertGuild(guildId) {
    const ts = iso();
    const existing = stmtSelectGuild.get(guildId);
    if (!existing) {
      stmtInsertNewGuild.run(guildId, ts, ts);
      return;
    }
    const gap = now().getTime() - Date.parse(existing.last_seen_at);
    if (gap > rejoinGapMs) stmtBumpRejoin.run(ts, guildId);
    else stmtRefreshSeen.run(ts, guildId);
  }

  /**
   * All guild ledger rows, oldest first (joined_at).
   * @returns {Array<{ guildId: string, joinedAt: string, lastSeenAt: string, rejoinCount: number }>}
   */
  function listGuilds() {
    return stmtListGuilds.all().map((r) => ({
      guildId: r.guild_id,
      joinedAt: r.joined_at,
      lastSeenAt: r.last_seen_at,
      rejoinCount: Number(r.rejoin_count),
    }));
  }

  return { getConfig, saveConfig, upsertGuild, listGuilds };
}

/**
 * In-memory Map-backed config store — the controller's default when no store
 * is injected (tests and DB-less deployments). Same { getConfig, saveConfig }
 * shape and the SAME validation as the SQLite store (shared parsers, no
 * duplication). getConfig is a lazy read-time fallback: an unknown guild
 * returns the seed values and materializes no row (mirrors the SQLite
 * seed-default semantics).
 * @param {{
 *   transcribeEnabled: boolean,
 *   dmAudioEnabled: boolean,
 *   dmTranscribeEnabled: boolean,
 *   autostopMinutes: number,
 * }} seedDefaults
 */
export function createMapConfigStore(seedDefaults) {
  const rows = new Map(); // guildId -> config record

  /** @param {string} guildId */
  function getConfig(guildId) {
    return rows.get(guildId) ?? { ...seedDefaults };
  }

  /**
   * Validate the patch against the SAME checks as the SQLite store, resolve
   * every field against the current config, then materialize the row.
   * @param {string} guildId
   * @param {{
   *   transcribeEnabled?: boolean,
   *   dmAudioEnabled?: boolean,
   *   dmTranscribeEnabled?: boolean,
   *   autostopMinutes?: number,
   * }} patch
   */
  function saveConfig(guildId, patch) {
    const current = getConfig(guildId);
    const { autostopMinutes, transcribeEnabled, dmAudioEnabled, dmTranscribeEnabled } =
      validatePatchFields(current, patch);
    rows.set(guildId, { transcribeEnabled, dmAudioEnabled, dmTranscribeEnabled, autostopMinutes });
  }

  return { getConfig, saveConfig };
}
