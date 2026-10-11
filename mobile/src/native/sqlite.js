import { openDatabaseSync } from 'expo-sqlite';

/**
 * Wraps expo-sqlite's sync API to look like node:sqlite's `DatabaseSync`
 * (`.exec`, `.prepare().run/get/all`) so mobile/src/core/clips-store.js runs
 * unchanged on the phone and in tests (test/mobile-clips-store.test.mjs uses
 * the real node:sqlite). Expo's SQLite API was deliberately aligned with
 * node:sqlite for this kind of sharing, but this file has not been run on a
 * device in this session (no simulator available here) — if a field name
 * below is off, it'll throw loudly on first use rather than corrupt data.
 */
export function openLocalDb(name = 'phone-recorder.db') {
  const db = openDatabaseSync(name);
  return {
    exec: (sql) => db.execSync(sql),
    prepare: (sql) => {
      const stmt = db.prepareSync(sql);
      return {
        run: (...params) => {
          const res = stmt.executeSync(params);
          return { changes: res.changes, lastInsertRowid: res.lastInsertRowId ?? res.lastInsertRowid };
        },
        get: (...params) => stmt.executeSync(params).getFirstSync(),
        all: (...params) => stmt.executeSync(params).getAllSync(),
      };
    },
  };
}
