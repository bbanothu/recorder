# Design: Config/Command Overhaul + SQLite Persistence

Status: **Approved** (user sign-off in chat, 2026-09-21)

## Goal
Rework the bot's config surface — `RECORDING_TYPE` replaces `SINGLE_FILE`, transcription gets a runtime `/transcribe` toggle, commands are documented via `/help` — and add a `node:sqlite` persistence layer so per-guild settings survive restarts.

## Users / actors
- Operator (env vars, `.env`, docker-compose, Docker image).
- Guild members running slash commands.
- Single bot instance, currently one guild; process restarts are routine.

## Key decisions (user-approved)
1. **`RECORDING_TYPE=PER_USER|MASTER`** replaces `SINGLE_FILE` (bool). Hard cutover, major version 2.0.0: if `SINGLE_FILE` is present at startup, `loadEnv()` throws with a message naming `RECORDING_TYPE`. No silent back-compat.
2. **`TRANSCRIBE_MODE` stays as-is** (`combined|master|off`) — it decides *what* gets transcribed. `TRANSCRIBE` (bool) stays and becomes the runtime-toggleable master switch via `/transcribe`, persisted per guild. Effective transcription is OFF when `TRANSCRIBE=false` **or** mode is `off`.
3. **SQLite via `node:sqlite`** (built into Node; **unflagged since v22.13.0** —
   behind `--experimental-sqlite` in 22.5–22.12; verified working on host Node
   v26.7.0). Zero new npm dependencies. DB file located by new `DB_PATH` env
   (Docker: on the `/data` volume).
4. **Config lives in SQLite keyed by `guild_id`**, with env values as
   read-time seed defaults for guilds that haven't customized yet (lazy
   seeding — see Precedence / semantics).
5. **Open registration, automatic and permanent**: any guild that invites the bot is auto-registered on `GuildCreate`; no `/join` or `/leave` commands. DB row records first-join time and rejoin count.
6. **`RECORDING_TYPE=BOTH` is DEFERRED** to a separate future feature with its own design pass (two audio sinks, delivery zip growth, transcription-target ambiguity).

## Data model (SQLite)
```sql
CREATE TABLE IF NOT EXISTS guilds (
  guild_id     TEXT PRIMARY KEY,
  joined_at    TEXT NOT NULL,          -- ISO timestamp, first contact
  last_seen_at TEXT NOT NULL,          -- updated on every GuildCreate
  rejoin_count INTEGER NOT NULL DEFAULT 0
);
-- NOTE (rejoin semantics): discord.js fires GuildCreate not only on real
-- invites but also on gateway reconnect / GUILD_CREATE bursts (seen live in
-- 1.5.x). upsertGuild therefore bumps rejoin_count ONLY when more than 10
-- minutes have elapsed since the previous last_seen_at; same-day reconnect
-- bursts refresh last_seen_at without inflating the count. The count is
-- best-effort signal, not an exact invite audit.

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id            TEXT PRIMARY KEY REFERENCES guilds(guild_id),
  record_type         TEXT NOT NULL,    -- 'PER_USER' | 'MASTER'
  transcribe_enabled  INTEGER NOT NULL, -- 0/1, runtime /transcribe toggle
  transcribe_mode     TEXT NOT NULL,    -- 'combined' | 'master' | 'off'
  autostop_minutes    INTEGER NOT NULL,
  updated_at          TEXT NOT NULL
);
```

Foreign keys are enforced (`PRAGMA foreign_keys = ON` at init); `saveConfig`
ensures the ledger row exists first (`INSERT OR IGNORE` into `guilds`), so
`guild_config` always has a parent and a slash command can never fail on a
missing ledger row.

## Precedence / semantics
- **Seed defaults are lazy (a read-time fallback), not persisted at first
  contact.** A guild with no DB row gets env values on every `getConfig`
  read (`RECORDING_TYPE`, `parseTranscribeMode(env.TRANSCRIBE_MODE)`,
  `AUTO_STOP_MINUTES`, `TRANSCRIBE`) — no write-on-read. Consequence: env
  changes DO propagate to
  never-customized guilds; the moment a guild's first slash-command write
  creates its row, that row wins forever and env stops propagating to it.
  (This supersedes the earlier "seeded once at first contact" wording —
  lazy seed-on-read is the implemented design.)
- **Env is seed-only for customized guilds.** After a guild's row exists,
  env changes never affect that guild — the runtime DB value wins forever
  (including `/transcribe` overriding an env `TRANSCRIBE=false`, and vice
  versa).
- Slash-command writes (`/record_type`, `/transcribe`, `/autostop <minutes>`)
  upsert into `guild_config` right away; WHEN each takes effect for a live
  session is pinned by the session snapshot points below.
- On restart, guild config is read back from SQLite — no more "resets to env
  on restart" caveat.
- **Seed decoupling (1.x back-compat trap):** the guild row's
  `transcribe_mode` is seeded from the RAW env `TRANSCRIBE_MODE`
  (`parseTranscribeMode(env.TRANSCRIBE_MODE)`), NOT from
  `effectiveTranscribeMode(env)` — the effective collapse would bake
  `'off'` into the row for `TRANSCRIBE=false` deployments, and since there
  is no runtime command to change mode, `/transcribe TRUE` could then never
  actually enable transcription. The 1.x `TRANSCRIBE=false` meaning is
  carried entirely by `transcribe_enabled=false`; effective transcription
  stays `transcribe_enabled && mode !== 'off'`.
- **Session snapshot points (fixed, not implementer's choice):**
  - `/record_type` — snapshot at `/record` session start. A mid-session
    change writes the store and affects the NEXT session; the in-flight
    session keeps its start-time recording type (its recorder/audio sinks
    were built at start).
  - `/autostop` — takes effect IMMEDIATELY, including the current session
    (unchanged 1.x behavior: the auto-stop timer re-reads the guild's
    threshold from the store each tick; the session-start snapshot sets only
    the initial value). Mid-session `/autostop 15` must change the running
    timer's threshold, as it does today.
  - `/transcribe` — the transcription mode/target is read at `stopSession`
    time, so a mid-session `/transcribe` still changes whether the in-flight
    session transcribes.

## Cross-guild leak fix (side effect)
The controller's singleton closure variables (`singleFileMode`,
`autoStopThresholdMs`, `transcribeMode`) become per-guild lookups via an
injectable `getConfig(guildId)` / `saveConfig(guildId, patch)` dep pair.
Default implementation (used by index.js) is SQLite-backed; the in-code
fallback is a plain `Map` so existing tests and DB-less deployments keep
working. This eliminates the existing bug where guild A's `/autostop 15` or
`/singlefile` bleeds into guild B on the same bot. The store is always
synchronous from the controller's perspective (`node:sqlite` `DatabaseSync`
in prod, in-memory Map in tests) — no async config reads inside the voice
pipeline.

## Command surface (v2.0.0)
| Command | Change |
|---|---|
| `/record_type PER_USER\|MASTER` | Replaces `/singlefile`. Omit arg to view current. Persisted. |
| `/transcribe TRUE\|FALSE` | New. Omit arg to view current. Persisted. |
| `/autostop [minutes]` | Unchanged UX; now persists (no reset on restart). |
| `/help` | New. Lists every command, one-line description + one usage example each. |
| `/record` | Confirmation reply appends: `Tip: /autostop, /transcribe, /record_type change settings; /help lists everything.` |
| `/stop` | Unchanged. |

## Env surface (v2.0.0)
- `RECORDING_TYPE=PER_USER|MASTER` (new; defaults to `PER_USER` when unset — it is not a required var, unlike `DISCORD_BOT_TOKEN`/`MEETINGS_DIR`/`GUILD_IDS`).
- `SINGLE_FILE` — REMOVED; startup error if present.
- `TRANSCRIBE=TRUE|FALSE` — kept; runtime-toggleable via `/transcribe`.
- `TRANSCRIBE_MODE=combined|master|off` — kept, unchanged semantics.
- `DB_PATH=<file>` — new; SQLite database FILE path. Default when unset:
  `<MEETINGS_DIR>/recorder.db` (a plain disk file next to the recordings).
  Under Docker, compose sets `DB_PATH=/data/recorder.db` — the DEFAULT is
  the `recordings` named volume, so the DB persists across redeploys like
  the recordings do. A host-disk file instead of the volume is supported via
  a bind mount; `docker-compose.yml` ships a commented-out example (bind a
  host DIRECTORY, never a single file — WAL journaling creates `-wal`/
  `-shm` sidecars next to the DB). Moving `DB_PATH` after first run leaves
  the old DB (and its per-guild settings) behind.
- `GUILD_IDS` — kept, REQUIRED, unchanged: it gates slash-command registration
  at startup. It is deliberately NOT the registration authority (any guild
  that invites the bot gets commands via GuildCreate deploy) — it is the
  operator's "which guilds do I expect this bot in" loud-declaration list:
  if the token is valid but a listed guild isn't joined, deployment fails
  audibly instead of the bot silently living in unlisted guilds. Keeping it
  required preserves that operator audit property; a deprecation/optional
  path is a possible future change, not in 2.0.0.
- All other vars unchanged (`WHISPER_MODEL`, `WHISPER_PYTHON`,
  `WHISPER_CPU_THREADS`, `MASTER_BITRATE`, `AUTO_STOP_MINUTES`,
  `MEETINGS_DIR`, `DISCORD_BOT_TOKEN`).

## Out of scope (deferred)
- `RECORDING_TYPE=BOTH` (separate future feature).
- `/join`, `/leave`, invite allowlisting, open-registration opt-out.
- Per-channel or per-user config.
- Guild-scoped recording paths: recordings land in a flat
  `discord-meetings/meeting-<UTC stamp>/` layout with no guild component
  (verified: `src/session.js#sessionDir`, `src/recorder.js`,
  `src/deliver.js` carry no guild context). Safe today only because
  `bot.js` enforces ONE session process-wide (`let session = null` — a
  second `/record` replies "Already recording"), so sessions can never
  interleave. Deferred to the v3.0.0 multi-guild feature (guild
  subdirectories e.g. `<guildId>/meeting-<stamp>/`, plus transcript
  placement and delivery-side guild attribution). Until then, with
  multiple guilds the flat layout mixes folders from different guilds —
  distinguishable only by timestamp, attributable via the `guilds` ledger.
- Sharding / multi-instance deployments (irrelevant at current scale; single
  process + in-process SQLite is sufficient well past 2,500 guilds).
- CONCURRENT sessions (a second recording while one is live): rejected
  process-wide today; per-guild concurrency is a v3.0.0 design question
  (voice-pipeline isolation, disk/IO budget, transcription sidecar
  serialization) and is deliberately not touched by 2.0.0.

## Acceptance criteria
1. Startup with `SINGLE_FILE` set exits with an error naming `RECORDING_TYPE`.
2. `/record_type`, `/transcribe`, `/autostop` changes persist across a full
   process restart (verified via DB read-back tests).
3. Two guilds changing settings independently never affect each other.
4. `/help` lists all commands with descriptions and one example each; `/record`
   reply includes the settings hint.
5. Guild ledger rows are created on `GuildCreate` and gap-gated on rejoin
   (reconnect bursts inside 10 minutes never inflate `rejoin_count`).
6. `npm test` green; docs (`.env.example`, README, SETUP), package.json
   `2.0.0`, and CHANGELOG entry ship in the release commit per AGENTS.md.

## Risks / tradeoffs
- "Off" is expressible two ways (`TRANSCRIBE=false` and mode `off`);
  precedence is documented in `/help`, README, `.env.example`.
- Breaking env change: operator's `.env` and `docker-compose.yml` must be
  updated in the same release.
- `node:sqlite` requires Node ≥22.13 (unflagged; 22.5–22.12 only have it
  behind `--experimental-sqlite`). The repo has no `engines` field today —
  Task 7 adds `"engines": { "node": ">=22.13" }` and Docker uses
  `node:22` (fine). The plan implements this: Task 5 adds the explicit
  version guard at startup (loud exit naming `node:sqlite` before DB open).
- Ledger rejoin semantics are best-effort by design: a guild absent 30 days
  then re-invited shows +1 rejoin with its original joinedAt — acceptable
  signal for "who is registered with us"; it is not an invite audit trail.
