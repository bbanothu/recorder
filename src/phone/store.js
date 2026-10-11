/**
 * Phone recorder store on a node:sqlite DatabaseSync (its own file, never the
 * bot's recorder.db or the notetaker's DB). Chunks are the rolling buffer;
 * clips are what the user chose to keep.
 */

/** @param {InstanceType<import('node:sqlite').DatabaseSync>} db */
export function initPhoneSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS devices (
      device_id      TEXT PRIMARY KEY,
      window_minutes INTEGER NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      device_id     TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL,
      path          TEXT NOT NULL,
      state         TEXT NOT NULL, -- received | transcribed | failed
      segments_path TEXT,
      received_at   TEXT NOT NULL,
      PRIMARY KEY (device_id, started_at)
    );

    CREATE TABLE IF NOT EXISTS clips (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id          TEXT NOT NULL,
      from_ms            INTEGER NOT NULL,
      to_ms              INTEGER NOT NULL,
      state              TEXT NOT NULL, -- pending | ready
      md_path            TEXT,
      audio_path         TEXT,
      language           TEXT,
      translated_md_path TEXT,
      created_at         TEXT NOT NULL
    );
  `);

  // v1 -> v2: a clip's detected language, and a cached English translation
  // (Whisper's own translate task, run on request — see service.js
  // translateClip). Existing rows just have both as null until re-translated.
  const clipColumns = new Set(db.prepare("PRAGMA table_info('clips')").all().map((c) => c.name));
  if (!clipColumns.has('language')) db.exec('ALTER TABLE clips ADD COLUMN language TEXT');
  if (!clipColumns.has('translated_md_path')) db.exec('ALTER TABLE clips ADD COLUMN translated_md_path TEXT');
}

/**
 * @param {InstanceType<import('node:sqlite').DatabaseSync>} db
 * @param {{ now?: () => Date, defaultWindowMinutes: number }} opts
 */
export function createPhoneStore(db, { now = () => new Date(), defaultWindowMinutes }) {
  initPhoneSchema(db);
  const iso = () => now().toISOString();

  const stmtWindow = db.prepare('SELECT window_minutes FROM devices WHERE device_id = ?');
  const stmtSetWindow = db.prepare(`
    INSERT INTO devices (device_id, window_minutes, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET window_minutes = excluded.window_minutes, updated_at = excluded.updated_at
  `);
  const stmtAddChunk = db.prepare(`
    INSERT OR IGNORE INTO chunks (device_id, started_at, duration_ms, path, state, received_at)
    VALUES (?, ?, ?, ?, 'received', ?)
  `);
  const stmtTranscribed = db.prepare(
    "UPDATE chunks SET state = 'transcribed', segments_path = ? WHERE device_id = ? AND started_at = ?",
  );
  const stmtFailed = db.prepare("UPDATE chunks SET state = 'failed' WHERE device_id = ? AND started_at = ?");
  const stmtRequeue = db.prepare(
    "UPDATE chunks SET state = 'received', segments_path = NULL WHERE device_id = ? AND started_at = ? AND state = 'failed'",
  );
  const stmtInState = db.prepare('SELECT * FROM chunks WHERE state = ? ORDER BY started_at, device_id');
  const stmtOverlap = db.prepare(`
    SELECT * FROM chunks
    WHERE device_id = ? AND started_at < ? AND started_at + duration_ms > ?
    ORDER BY started_at
  `);
  const stmtAll = db.prepare('SELECT * FROM chunks ORDER BY started_at, device_id');
  const stmtDeleteChunk = db.prepare('DELETE FROM chunks WHERE device_id = ? AND started_at = ?');
  const stmtCreateClip = db.prepare(
    "INSERT INTO clips (device_id, from_ms, to_ms, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
  );
  const stmtFinishClip = db.prepare("UPDATE clips SET state = 'ready', md_path = ?, audio_path = ?, language = ? WHERE id = ?");
  const stmtSetTranslation = db.prepare('UPDATE clips SET translated_md_path = ? WHERE id = ?');
  const stmtSetMdPath = db.prepare('UPDATE clips SET md_path = ? WHERE id = ?');
  const stmtSetAudioPath = db.prepare('UPDATE clips SET audio_path = ? WHERE id = ?');
  const stmtSetLanguage = db.prepare('UPDATE clips SET language = ? WHERE id = ?');
  const stmtGetClip = db.prepare('SELECT * FROM clips WHERE device_id = ? AND id = ?');
  const stmtDeleteClip = db.prepare('DELETE FROM clips WHERE device_id = ? AND id = ?');
  const stmtListClips = db.prepare('SELECT * FROM clips WHERE device_id = ? ORDER BY id DESC');
  const stmtPending = db.prepare("SELECT * FROM clips WHERE state = 'pending' ORDER BY id DESC");

  const toChunk = (r) => ({
    deviceId: r.device_id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    path: r.path,
    state: r.state,
    segmentsPath: r.segments_path ?? null,
  });
  const toClip = (r) => ({
    id: r.id,
    deviceId: r.device_id,
    fromMs: r.from_ms,
    toMs: r.to_ms,
    state: r.state,
    mdPath: r.md_path ?? null,
    audioPath: r.audio_path ?? null,
    language: r.language ?? null,
    translatedMdPath: r.translated_md_path ?? null,
    createdAt: r.created_at,
  });
  const windowMinutes = (deviceId) => stmtWindow.get(deviceId)?.window_minutes ?? defaultWindowMinutes;

  return {
    windowMinutes,
    setWindow: (deviceId, minutes) => {
      stmtSetWindow.run(deviceId, minutes, iso());
    },
    /** @returns {boolean} true when the chunk is new */
    addChunk: ({ deviceId, startedAt, durationMs, path }) =>
      stmtAddChunk.run(deviceId, startedAt, durationMs, path, iso()).changes > 0,
    setChunkTranscribed: (deviceId, startedAt, segmentsPath) => {
      stmtTranscribed.run(segmentsPath, deviceId, startedAt);
    },
    setChunkFailed: (deviceId, startedAt) => {
      stmtFailed.run(deviceId, startedAt);
    },
    /** Put a failed chunk back in the queue. @returns {boolean} true if it was failed */
    requeueFailedChunk: (deviceId, startedAt) => stmtRequeue.run(deviceId, startedAt).changes > 0,
    chunksInState: (state) => stmtInState.all(state).map(toChunk),
    /** Chunks intersecting [fromMs, toMs). */
    chunksOverlapping: (deviceId, fromMs, toMs) => stmtOverlap.all(deviceId, toMs, fromMs).map(toChunk),
    /** Chunks whose end is older than `nowMs − window` of their device. */
    expiredChunks: (nowMs) =>
      stmtAll
        .all()
        .map(toChunk)
        .filter((c) => c.startedAt + c.durationMs < nowMs - windowMinutes(c.deviceId) * 60_000),
    deleteChunk: (deviceId, startedAt) => {
      stmtDeleteChunk.run(deviceId, startedAt);
    },
    createClip: ({ deviceId, fromMs, toMs }) => Number(stmtCreateClip.run(deviceId, fromMs, toMs, iso()).lastInsertRowid),
    finishClip: (id, { mdPath, audioPath, language }) => {
      stmtFinishClip.run(mdPath, audioPath, language ?? null, id);
    },
    setClipTranslation: (id, translatedMdPath) => {
      stmtSetTranslation.run(translatedMdPath, id);
    },
    /** null clears it (the transcript was deleted, or never existed). */
    setClipMdPath: (id, mdPath) => {
      stmtSetMdPath.run(mdPath, id);
    },
    /** null clears it (the audio was deleted, or concat never kept any). */
    setClipAudioPath: (id, audioPath) => {
      stmtSetAudioPath.run(audioPath, id);
    },
    setClipLanguage: (id, language) => {
      stmtSetLanguage.run(language, id);
    },
    getClip: (deviceId, id) => {
      const r = stmtGetClip.get(deviceId, id);
      return r ? toClip(r) : null;
    },
    /** @returns the deleted clip (so the caller can clean up its files), or null if there wasn't one */
    deleteClip: (deviceId, id) => {
      const r = stmtGetClip.get(deviceId, id);
      if (!r) return null;
      stmtDeleteClip.run(deviceId, id);
      return toClip(r);
    },
    listClips: (deviceId) => stmtListClips.all(deviceId).map(toClip),
    pendingClips: () => stmtPending.all().map(toClip),
  };
}
