/**
 * Notetaker schedule store on a node:sqlite DatabaseSync (its own file, never
 * the Discord bot's recorder.db). One row per invite UID; a recurring series
 * keeps one row whose times advance to the next occurrence (rollover).
 */

export const MEETING_STATES = Object.freeze([
  'scheduled', // waiting for its start time
  'dispatched', // handed to the joiner
  'recording', // the joiner is in the call
  'done',
  'failed',
  'missed', // ended before it was ever dispatched (e.g. the process was down)
  'cancelled',
]);

/** States that no rollover may touch while the meeting window is open. */
const LIVE = new Set(['recording']);

/** @param {InstanceType<import('node:sqlite').DatabaseSync>} db */
export function initScheduleSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS meetings (
      uid        TEXT PRIMARY KEY,
      sequence   INTEGER NOT NULL,
      platform   TEXT,
      join_url   TEXT,
      organizer  TEXT,
      summary    TEXT,
      starts_at  INTEGER,
      ends_at    INTEGER,
      recurring  INTEGER NOT NULL DEFAULT 0,
      ics        TEXT,
      state      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      key          TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
  `);
}

/**
 * @param {InstanceType<import('node:sqlite').DatabaseSync>} db
 * @param {{ now?: () => Date }} [opts]
 */
export function createScheduleStore(db, { now = () => new Date() } = {}) {
  initScheduleSchema(db);
  const iso = () => now().toISOString();

  const stmtGet = db.prepare('SELECT * FROM meetings WHERE uid = ?');
  const stmtInsert = db.prepare(`
    INSERT INTO meetings (uid, sequence, platform, join_url, organizer, summary, starts_at, ends_at, recurring, ics, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdate = db.prepare(`
    UPDATE meetings SET sequence = ?, platform = ?, join_url = ?, organizer = ?, summary = ?,
      starts_at = ?, ends_at = ?, recurring = ?, ics = ?, state = ?, updated_at = ?
    WHERE uid = ?
  `);
  const stmtCancel = db.prepare(
    "UPDATE meetings SET sequence = ?, state = 'cancelled', updated_at = ? WHERE uid = ?",
  );
  const stmtSetState = db.prepare('UPDATE meetings SET state = ?, updated_at = ? WHERE uid = ?');
  const stmtSetTimes = db.prepare(
    "UPDATE meetings SET starts_at = ?, ends_at = ?, state = 'scheduled', updated_at = ? WHERE uid = ?",
  );
  const stmtEndSeries = db.prepare(
    "UPDATE meetings SET recurring = 0, state = 'done', updated_at = ? WHERE uid = ?",
  );
  const stmtDue = db.prepare(`
    SELECT * FROM meetings
    WHERE state = 'scheduled' AND starts_at IS NOT NULL
      AND starts_at - ? <= ? AND ends_at > ?
    ORDER BY starts_at, uid
  `);
  const stmtEnded = db.prepare(`
    SELECT * FROM meetings
    WHERE state != 'cancelled' AND ends_at IS NOT NULL AND ends_at <= ?
    ORDER BY starts_at, uid
  `);
  const stmtList = db.prepare('SELECT * FROM meetings ORDER BY starts_at, uid');
  const stmtSeen = db.prepare('SELECT 1 FROM processed_messages WHERE key = ?');
  const stmtMarkSeen = db.prepare(
    'INSERT OR IGNORE INTO processed_messages (key, processed_at) VALUES (?, ?)',
  );

  /** @param {Record<string, any>} r */
  function toMeeting(r) {
    return {
      uid: r.uid,
      sequence: r.sequence,
      platform: r.platform,
      joinUrl: r.join_url,
      organizer: r.organizer,
      summary: r.summary,
      startsAtMs: r.starts_at,
      endsAtMs: r.ends_at,
      recurring: Boolean(r.recurring),
      ics: r.ics,
      state: r.state,
    };
  }

  /**
   * Fold one parsed invite into the store (RFC 5546 SEQUENCE ordering).
   * @param {ReturnType<typeof import('./invite.js').parseInvites>[number]} inv
   * @returns {'added' | 'updated' | 'cancelled' | 'stale' | 'unchanged'}
   */
  function applyInvite(inv) {
    const ts = iso();
    const existing = stmtGet.get(inv.uid);
    const fields = [
      inv.platform, inv.joinUrl, inv.organizer, inv.summary,
      inv.startsAtMs, inv.endsAtMs, inv.recurring ? 1 : 0, inv.ics,
    ];
    if (!existing) {
      const state = inv.cancelled ? 'cancelled' : 'scheduled';
      stmtInsert.run(inv.uid, inv.sequence, ...fields, state, ts);
      return inv.cancelled ? 'cancelled' : 'added';
    }
    if (inv.sequence < existing.sequence) return 'stale';
    if (inv.cancelled) {
      if (existing.state === 'cancelled' && inv.sequence === existing.sequence) return 'unchanged';
      stmtCancel.run(inv.sequence, ts, inv.uid);
      return 'cancelled';
    }
    // A cancel wins at an equal SEQUENCE: only a newer revision revives it.
    if (existing.state === 'cancelled' && inv.sequence === existing.sequence) return 'stale';

    const sameSlot = existing.starts_at === inv.startsAtMs && existing.join_url === inv.joinUrl;
    if (
      sameSlot &&
      existing.state !== 'cancelled' &&
      existing.sequence === inv.sequence &&
      existing.ends_at === inv.endsAtMs &&
      existing.organizer === inv.organizer &&
      existing.summary === inv.summary
    ) {
      return 'unchanged';
    }
    // Same time and link → a cosmetic edit: keep the live state so an
    // already-dispatched meeting is never joined twice.
    const state = sameSlot && existing.state !== 'cancelled' ? existing.state : 'scheduled';
    stmtUpdate.run(inv.sequence, ...fields, state, ts, inv.uid);
    return 'updated';
  }

  /**
   * Scheduled meetings whose start is within `leadMs` and whose end is still
   * ahead (a late start or a restart mid-meeting still joins).
   */
  function dueJobs(nowMs, leadMs) {
    return stmtDue.all(leadMs, nowMs, nowMs).map(toMeeting);
  }

  /**
   * Settle every meeting whose window has closed. One-offs: scheduled →
   * missed, dispatched → done. Recurring: advance to `nextOccurrence(row,
   * nowMs)` and schedule it, or end the series. Idempotent per tick.
   * @param {number} nowMs
   * @param {(meeting: ReturnType<typeof toMeeting>, nowMs: number) => { startsAtMs: number | null, endsAtMs: number | null } | null | undefined} nextOccurrence
   */
  function rollover(nowMs, nextOccurrence) {
    const changes = [];
    const ts = iso();
    for (const row of stmtEnded.all(nowMs)) {
      if (LIVE.has(row.state)) continue;
      const m = toMeeting(row);
      if (m.recurring) {
        const next = nextOccurrence(m, nowMs);
        if (next?.startsAtMs != null && next.endsAtMs > nowMs) {
          stmtSetTimes.run(next.startsAtMs, next.endsAtMs, ts, m.uid);
          changes.push({ uid: m.uid, state: 'scheduled', startsAtMs: next.startsAtMs });
        } else {
          stmtEndSeries.run(ts, m.uid);
          changes.push({ uid: m.uid, state: 'done' });
        }
        continue;
      }
      if (m.state === 'scheduled') {
        stmtSetState.run('missed', ts, m.uid);
        changes.push({ uid: m.uid, state: 'missed' });
      } else if (m.state === 'dispatched') {
        stmtSetState.run('done', ts, m.uid);
        changes.push({ uid: m.uid, state: 'done' });
      }
    }
    return changes;
  }

  /**
   * Startup repair: a meeting left `dispatched`/`recording` belonged to a
   * process that died. Still running → schedule it again (the spec's "a job
   * whose start has passed but whose end has not is still joined"); over →
   * done. Returns the uids put back on the schedule.
   * @param {number} nowMs
   */
  function recoverInterrupted(nowMs) {
    const ts = iso();
    const rejoin = [];
    for (const row of stmtList.all()) {
      if (row.state !== 'dispatched' && row.state !== 'recording') continue;
      const running = row.ends_at != null && row.ends_at > nowMs;
      stmtSetState.run(running ? 'scheduled' : 'done', ts, row.uid);
      if (running) rejoin.push(row.uid);
    }
    return rejoin;
  }

  function setState(uid, state) {
    if (!MEETING_STATES.includes(state)) throw new Error(`Unknown meeting state: ${state}`);
    stmtSetState.run(state, iso(), uid);
  }

  return {
    applyInvite,
    dueJobs,
    rollover,
    recoverInterrupted,
    setState,
    list: () => stmtList.all().map(toMeeting),
    isMessageProcessed: (key) => Boolean(stmtSeen.get(key)),
    markMessageProcessed: (key) => {
      stmtMarkSeen.run(key, iso());
    },
  };
}
