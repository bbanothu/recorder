/**
 * Local (on-device) clip tracking, same DI pattern as src/phone/store.js: a
 * DatabaseSync-shaped `db` (`.exec`, `.prepare().run/get/all`) so this file
 * runs unchanged against node:sqlite in tests and the expo-sqlite adapter
 * (mobile/src/native/sqlite.js) on the phone. A clip's audio is whatever
 * files live under `dir` (mobile/src/native/local-clips.js) — this table
 * only remembers that the clip exists, its time range, and where to look.
 */

/** @param {InstanceType<import('node:sqlite').DatabaseSync>} db */
export function initClipsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_clips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ms     INTEGER NOT NULL,
      to_ms       INTEGER NOT NULL,
      dir         TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
}

/**
 * @param {InstanceType<import('node:sqlite').DatabaseSync>} db
 * @param {{ now?: () => Date }} [opts]
 */
export function createClipsStore(db, { now = () => new Date() } = {}) {
  initClipsSchema(db);

  const stmtCreate = db.prepare(
    'INSERT INTO local_clips (from_ms, to_ms, dir, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const stmtGet = db.prepare('SELECT * FROM local_clips WHERE id = ?');
  const stmtList = db.prepare('SELECT * FROM local_clips ORDER BY id DESC');
  const stmtDelete = db.prepare('DELETE FROM local_clips WHERE id = ?');

  const toClip = (r) =>
    r && {
      id: r.id,
      fromMs: r.from_ms,
      toMs: r.to_ms,
      dir: r.dir,
      chunkCount: r.chunk_count,
      createdAt: r.created_at,
    };

  return {
    /** @returns {number} the new clip's id */
    createClip: ({ fromMs, toMs, dir, chunkCount }) =>
      Number(stmtCreate.run(fromMs, toMs, dir, chunkCount, now().toISOString()).lastInsertRowid),
    getClip: (id) => toClip(stmtGet.get(id)) ?? null,
    listClips: () => stmtList.all().map(toClip),
    deleteClip: (id) => {
      stmtDelete.run(id);
    },
  };
}
