# Config Overhaul + SQLite Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SINGLE_FILE` with `RECORDING_TYPE=PER_USER|MASTER`, add `/transcribe`, `/record_type`, and `/help` commands with a `/record` settings hint, and persist per-guild settings + guild registration in SQLite (`node:sqlite`) so settings survive restarts and never leak across guilds.

**Architecture:** A new `src/db.js` module wraps `node:sqlite` (`DatabaseSync`) with two tables (`guilds`, `guild_config`), exposing `getConfig(guildId)` / `saveConfig(guildId, patch)` plus guild-ledger functions. The session controller's singleton closure state (`singleFileMode`, `autoStopThresholdMs`, `transcribeMode`) becomes per-guild lookups through an injectable config-store dep (Map fallback for tests). `src/env.js` swaps `SINGLE_FILE` for `RECORDING_TYPE` with a hard, loud cutover error.

**Tech Stack:** Node ≥22.13 ESM (unflagged `node:sqlite` landed in v22.13.0; behind `--experimental-sqlite` in 22.5–22.12), `node:sqlite` (`DatabaseSync`, built-in, zero new deps), discord.js v14, `node --test` (TDD), Docker `node:22-bookworm-slim`.

**Design doc (source of truth):** `.project/specs/config-sqlite-overhaul.md`

**Repo:** `C:\Users\wot38\Documents\GitHub\discord-meeting-recorder` — **branch: `feat/config-overhaul-sqlite`** (created from `master` @ `7116178` after `feat/per-user-transcription` was merged; baseline 183/183 green on it). All paths below are relative to the repo. Version before this feature: `1.7.0`; this ships as **`2.0.0`** (major, breaking env change) per AGENTS.md release pattern.

**GATE EXCEPTION (stated up front, per AGENTS.md "all tests green before commit"):** Tasks 1–3 create a deliberate RED window: Task 1 changes `src/env.js` and temporarily breaks `bot.test.mjs` (fixed in Task 3). Within this feature only, intermediate `feat!`/`feat:` commits are allowed with a non-green suite **provided** the commit message carries the suffix `(WIP: suite red — see plan Task 1 gate exception)` and the failing list recorded in the task's step 5. The exception ends at Task 5: from Task 5 on, the full-suite-green rule applies without exception. An implementing agent must never commit a red suite silently. (The RED window actually CLOSES at Task 3 step 5, when `bot.test.mjs` goes green and only `env.js`-import fallout in `index.js`-level tests can remain; Task 5 merely removes that last remnant.)

**Existing patterns to follow (from AGENTS.md and src/):**
- TDD: failing test first (RED), minimal implementation (GREEN), refactor.
- DI for time/IO: inject `now`, fs functions, and now the config store — tests never touch a real DB file (use `new DatabaseSync(':memory:')`).
- Pure decision logic in its own module; keep `bot.js` glue thin.
- Env validation at load time in `src/env.js`, loud errors.
- Docs that must ship with the version bump: `.env.example`, `README.md`, `SETUP.md`, `CHANGELOG.md` (heading must match package.json exactly), `docker-compose.yml` if env surface changes.

---

## Acceptance criteria

1. Startup with `SINGLE_FILE` set exits with an error naming `RECORDING_TYPE`.
2. `/record_type`, `/transcribe`, `/autostop` changes persist across a full process restart.
3. Two guilds changing settings independently never affect each other.
4. `/help` lists all commands with a description and one usage example each; `/record` reply includes the settings hint.
5. Guild ledger rows are created on `GuildCreate` and updated (rejoin count, last-seen) on rejoin.
6. `npm test` green; `.env.example`, README, SETUP, CHANGELOG `[2.0.0]`, docker-compose, package.json `2.0.0` all updated in the release commit.

## Out of scope

- `RECORDING_TYPE=BOTH` (separate future feature/design pass).
- `/join`, `/leave`, allowlisting, per-channel/per-user config, sharding.
- Guild-scoped recording paths (guild subdirectories under
  `discord-meetings/`) and per-guild CONCURRENT sessions — both deferred to
  v3.0.0 (spec Out-of-scope documents the rationale and the current
  one-session-at-a-time safety property). 2.0.0 must not change the flat
  `meeting-<stamp>/` layout or the process-wide single-session rule;
  Task 8's spec-compliance review checks this explicitly.

---

## Task 1: Env — `RECORDING_TYPE` replaces `SINGLE_FILE` (hard cutover)

Objective: `loadEnv()` returns `RECORDING_TYPE: 'PER_USER' | 'MASTER'`, rejects the old `SINGLE_FILE` var with a rename hint, and drops `effectiveTranscribeMode`'s coupling to the deleted var.

Files:
- Modify: `src/env.js`, `test/env.test.mjs`
- (Docs update `.env.example`/SETUP/README later — Task 6, not Task 8; Task 8 is review-only.)

Steps:
0. Verify the planning artifacts are committed on this branch: `git log --oneline -- .project` must show `86bbd24 v2.0.0 plan/spec` (they were committed pre-dispatch on master; expected result: nothing to do). If the output is empty for any reason, commit `.project/` before proceeding (`git add .project/ && git commit -m "docs: add 2.0.0 config/SQLite design spec and implementation plan"`) — never start the feature with untracked design provenance.
1. Write failing tests in `test/env.test.mjs` (replace the `SINGLE_FILE` describe blocks):
   - `loadEnv()` with `RECORDING_TYPE=MASTER` (and required vars `DISCORD_BOT_TOKEN`, `MEETINGS_DIR`, `GUILD_IDS` set) returns `{ RECORDING_TYPE: 'MASTER' }`; with `PER_USER` likewise; unset defaults to `'PER_USER'`.
   - Values are case-insensitive: `master` → `'MASTER'`.
   - Invalid value (`RECORDING_TYPE=BOTH`, since BOTH is deferred) throws `/RECORDING_TYPE: BOTH \(expected PER_USER\|MASTER\)/`.
   - `SINGLE_FILE` present (any value) → `loadEnv()` throws `/SINGLE_FILE is no longer supported. Use RECORDING_TYPE=PER_USER\|MASTER instead./`.
   - Keep existing `parseTranscribeMode` / `effectiveTranscribeMode` tests passing untouched.
2. Run: `node --test test/env.test.mjs`
   Expected: new tests fail (RED).
3. Implement in `src/env.js`:
   - Add `parseRecordingType(value)` (default `'PER_USER'`, case-insensitive, whitelist `['PER_USER','MASTER']`, loud error otherwise).
   - In `loadEnv()`: before anything else, `if (env.SINGLE_FILE != null && String(env.SINGLE_FILE).trim() !== '') throw new Error('SINGLE_FILE is no longer supported. Use RECORDING_TYPE=PER_USER|MASTER instead.')`.
   - Replace the `SINGLE_FILE` return field with `RECORDING_TYPE: parseRecordingType(env.RECORDING_TYPE)`.
4. Run: `node --test test/env.test.mjs`
   Expected: all green (GREEN).
5. Run full suite: `npm test`
   Expected: `bot.test.mjs` now fails (it still passes `singleFile:` and expects `SINGLE_FILE` naming) — that is the documented RED window; see the GATE EXCEPTION note in the plan header. Record the failing file list in the task notes.
6. Commit: `feat!: replace SINGLE_FILE env with RECORDING_TYPE (PER_USER|MASTER) (WIP: suite red — see plan Task 1 gate exception)`

## Task 2: SQLite config store (`src/db.js`) — pure module + tests

Objective: New `src/db.js` exposing an init function and a config-store object; fully tested against `:memory:`.

Files:
- Create: `src/db.js`, `test/db.test.mjs`

Steps:
1. Write failing tests in `test/db.test.mjs`:
   - `createConfigStore(new DatabaseSync(':memory:'))` returns `{ getConfig, saveConfig, upsertGuild, listGuilds }`.
   - Seed semantics (lazy, matching spec): `getConfig('g1')` with no rows returns the seed defaults passed at init — `{ recordType: 'PER_USER', transcribeEnabled: true, transcribeMode: 'combined', autostopMinutes: 5 }` — and does NOT write a row (verify row count still 0 after the read).
   - `saveConfig('g1', { autostopMinutes: 15 })` then `getConfig('g1')` returns `autostopMinutes: 15` with other fields at defaults.
   - `saveConfig` twice for the same guild updates rather than duplicating (row count 1).
   - Validation: `saveConfig('g1', { recordType: 'BOTH' })` throws; `saveConfig('g1', { transcribeMode: 'bogus' })` throws; `autostopMinutes` out of `1-180` (the `AUTO_STOP_MIN_MINUTES`/`MAX` constants from `src/auto-stop.js`) throws.
   - Rejoin-gap semantics: `upsertGuild('g1', t0)` inserts; a second `upsertGuild('g1', t0 + 2 minutes)` does NOT increment `rejoinCount` (reconnect burst) but refreshes `lastSeenAt`; `upsertGuild('g1', t0 + 30 minutes)` DOES increment (real rejoin) and preserves the original `joinedAt`. Gap constant: 10 minutes, injectable via `now` + a `rejoinGapMs` opt for tests. `GuildDelete` never touches the ledger (permanent rows by design — a long-absent guild that returns shows +1 rejoin with ancient joinedAt; best-effort, documented in the spec's Risks section).
   - FK safety: `saveConfig` in a guild with NO prior `upsertGuild` succeeds (ledger row is auto-created via `INSERT OR IGNORE`) — assert `guilds` row count went 0 → 1 and the config write landed.
   - Persistence across "restart": open a second `DatabaseSync` on a temp file (`os.tmpdir()` + random name, closed + deleted in `afterEach`), create the store, save, close; reopen, create a new store, `getConfig` returns the saved values.
   - `PRAGMA user_version = 1` is set at init (first schema; migrations bump it — do not conflate with the app's package.json version, which is 2.0.0). Read-back test asserts it.
2. Run: `node --test test/db.test.mjs`
   Expected: fail — module doesn't exist (RED).
3. Implement `src/db.js`:
   - `import { DatabaseSync } from 'node:sqlite'`; export `createConfigStore(db, { seedDefaults, now = () => new Date() })` and `initSchema(db)` (or fold schema creation into `createConfigStore`).
   - Two tables exactly as specced in `.project/specs/config-sqlite-overhaul.md` (`guilds`, `guild_config`), `CREATE TABLE IF NOT EXISTS`.
   - `getConfig` does `SELECT` → row mapped to camelCase; missing row → seed defaults (no write-on-read).
   - `saveConfig` = `INSERT ... ON CONFLICT(guild_id) DO UPDATE` with field validation (reuse `parseTranscribeMode`, `parseRecordingType`, `AUTO_STOP_MIN_MINUTES/MAX` imports — no duplicated validation logic). FK safety: before writing `guild_config`, `INSERT OR IGNORE` the parent `guilds` row (spec Data-model note) so a first-ever `saveConfig` in a guild that has no ledger row yet cannot throw a FOREIGN KEY constraint. `PRAGMA foreign_keys = ON` at init.
   - `upsertGuild` implements the 10-minute rejoin-gap semantics (see test spec above): refresh `last_seen_at` always; increment `rejoin_count` only when the gap since the previous `last_seen_at` exceeds `rejoinGapMs` (default 10 min).
   - WAL mode: `db.exec('PRAGMA journal_mode = WAL')` at init — on the `/data` volume a live recording process must never stall on a write lock. NOTE: `DatabaseSync` has NO `.pragma()` method (probed on Node 26.7.0) — use `db.exec()`. WAL only takes effect on a file-backed DB: on `:memory:` SQLite keeps `journal_mode = memory`, so do NOT assert `journal_mode = 'wal'` in the `:memory:` tests — assert it in the file-backed persistence test instead (open a `DatabaseSync` on the temp file, read back `PRAGMA journal_mode`). Plus `PRAGMA user_version = 1` (first schema; migrations bump it — must match the Task 2 test spec above).
   - All statements prepared once at store creation.
4. Run: `node --test test/db.test.mjs`
   Expected: green (GREEN).
5. Run: `npm test`
   Expected: only the Task 1 known failures remain.
6. Commit: `feat: add node:sqlite config store for per-guild settings and guild ledger`

## Task 3: Controller — per-guild config via injected store (kills the cross-guild leak)

Objective: `createSessionController` reads/writes config per guild through a `configStore` dep instead of singleton closure variables.

Files:
- Modify: `src/bot.js`, `test/bot.test.mjs`

Steps:
1. Write failing tests in `test/bot.test.mjs`:
   - New dep shape: `configStore = { getConfig(guildId), saveConfig(guildId, patch) }`. Controller default when omitted: in-memory `Map`-backed store (same semantics as `src/db.js`'s, seeded from the other controller deps for back-compat).
   - **Leak test (the acceptance criterion):** controller with a Map-backed store; run `/record_type master_only` in guild `g1`; then `getConfig('g2').recordType` is still `'PER_USER'` — and a `/record` in `g2` uses per-user mode while `g1` uses master. Assert via `debugSession()` after starting a session in each guild (or by inspecting the store directly).
   - Snapshot-point test (spec Precedence): start a session in `g1` with `recordType: 'PER_USER'`; run `/record_type MASTER` mid-session; assert `debugSession()`'s recorder was created with `writePerUserFiles: true` (session keeps its start-time mode) AND the store now holds `recordType: 'MASTER'` (next session gets it). Likewise `/transcribe FALSE` mid-session DOES affect that session's stop-time transcription target.
   - Autostop-immediacy test (1.x behavior preserved, spec snapshot points): `/autostop 15` mid-session updates the store AND changes the running session's effective threshold — assert via `evaluateAutoStop` receiving `thresholdMs = 15 * 60_000` on the next tick (the auto-stop timer re-reads the guild's config every tick; the session-start snapshot is only the initial value).
   - `/autostop 15` in `g1` writes `saveConfig('g1', { autostopMinutes: 15 })` and does not mutate `g2`.
   - `/transcribe` with no args replies with current effective state; `/transcribe FALSE` calls `saveConfig(guildId, { transcribeEnabled: false })`.
   - `/record_type PER_USER|MASTER` (new option names) upserts and replies with the new label text; the reply no longer says "Resets to the SINGLE_FILE env value on restart" — for THIS task keep 1.x-era wording, swapped to `RECORDING_TYPE`: "Resets to the RECORDING_TYPE env value on restart." Task 5 (persistence wiring) replaces it with the final wording ("Stored per guild; persists across restarts.") in the same commit that makes it true — never ship text that lies about behavior.
   - Existing `/singlefile` tests are updated to `/record_type` (command name, option name `state` → `record_type` with choices `PER_USER`/`MASTER`), not deleted.
2. Run: `node --test test/bot.test.mjs`
   Expected: new tests fail (RED).
3. Implement in `src/bot.js`:
   - Replace closure vars `singleFileMode`, `autoStopThresholdMs`, `transcribeMode`, `transcribeEnabled` with per-guild store reads: `record()` reads `configStore.getConfig(interaction.guildId)` at session start; `autostop()` / `recordType()` / `transcribe()` read-write through the store. The auto-stop timer body re-reads `getConfig(guildId).autostopMinutes` on every tick (preserves 1.x "applies immediately" behavior; session snapshot is only the initial value). Make it EXPLICIT in this task (spec Precedence, "/transcribe" snapshot point): `stopSession` re-reads `configStore.getConfig(guildId)` at stop time so a mid-session `/transcribe` affects the in-flight session's stop-time transcription target — do not reuse the session-start snapshot for the transcription gate.
   - FK safety: `saveConfig` upserts the `guilds` ledger row (`INSERT OR IGNORE`) before writing `guild_config` (spec Data-model note — a command in a guild with no ledger row must not throw).
   - `commandData`: rename command `singlefile` → `record_type` with description "Show or set the recording type"; string option `record_type` with choices `PER_USER`, `MASTER`; add `/transcribe` builder (string option `enabled`, choices `TRUE`/`FALSE`, optional = view mode).
   - Export a small `createMapConfigStore(seed)` helper from `bot.js` (or import from `db.js`) so `index.js` and tests share one implementation.
4. Run: `node --test test/bot.test.mjs`
   Expected: green (GREEN).
5. Run: `npm test`
   Expected: only `env.js`-import fallout in `index.js` (if any test covers it) remains.
6. Commit: `feat: per-guild session config with /record_type and /transcribe commands`

## Task 4: `/help` command + `/record` settings hint

Objective: `/help` lists every command with a one-line description and one usage example each; `/record`'s confirmation reply includes the tip line.

Files:
- Modify: `src/bot.js`, `test/bot.test.mjs`

Steps:
1. Write failing tests:
   - `commandData` includes a `help` command.
   - `/help` interaction replies with an ephemeral message containing, for each of `/record`, `/stop`, `/record_type`, `/transcribe`, `/autostop`, `/help`: the command name, a one-line description, and one example invocation (e.g. `` `/record_type MASTER` ``). Assert by matching substrings from the mock interaction's captured reply.
   - After a successful `/record` start, the `editReply` payload's content ends with the tip: `Tip: /autostop, /transcribe, /record_type change settings; /help lists everything.`
   - Check existing `/record` reply-shape assertions first: some 1.x tests may assert byte-exact editReply content — extend those assertions (old text + tip), never weaken them. If a byte-exact pin exists, update it in the same RED step and note it.
2. Run: `node --test test/bot.test.mjs` — Expected: fail (RED).
3. Implement:
   - `help(interaction)` handler in the controller (pure string-building helper `buildHelpText()` exported for easy testing), wired in `index.js`'s `InteractionCreate` dispatch and `commandData`.
   - Append the tip line in `record()`'s `editReply`.
4. Run: `node --test test/bot.test.mjs` — Expected: green.
5. Commit: `feat: /help command and settings hint on /record`

## Task 5: Wire SQLite into the app (`src/index.js`) + guild ledger events

Objective: Startup builds the real store from `DB_PATH`, seeds from env, registers `GuildCreate`/`GuildDelete` ledger hooks, and the controller gets the store.

Files:
- Modify: `src/index.js`, `test/bot.test.mjs` (ledger wiring tests if index-level tests exist; otherwise validate via a small integration test)

Steps:
1. Write failing tests (a new `test/index-wiring.test.mjs` is acceptable if `index.js` has no existing harness — follow the repo's DI style: extract a `createBot({ env, client, configStore, ... })` seam only if it can be done without a big refactor; otherwise test the wiring function extracted from index.js):
   - `GuildCreate` calls `upsertGuild(guildId)` exactly once per guild event; verify via the store that a burst of events inside the rejoin gap does not inflate `rejoinCount` (gap semantics live in the store; the wiring test asserts the call happens, not the count math).
   - `GuildDelete` still calls `deployGuildCommands.forget(guild.id)` (existing behavior preserved).
   - Controller receives the store; a `saveConfig` from a command round-trips into a later `record()` session (per-guild, via the shared store instance).
2. Run the new tests — Expected: fail (RED).
3. Implement in `src/index.js`:
   - `env.js` gains `DB_PATH` (required-with-default logic: default `<MEETINGS_DIR>/recorder.db`; throw if the parent directory can't be created/read). Add `DB_PATH` to the `loadEnv()` return + validation. NOTE: the default derivation gives `loadEnv()` an fs side effect (directory create) it doesn't have today — acceptable for startup, but tests that call `loadEnv()` with a `MEETINGS_DIR` must use a throwaway temp dir so the suite never writes into a real path (repo DI convention: tests never touch real fs).
   - Startup: `const db = new DatabaseSync(env.DB_PATH); const configStore = createConfigStore(db, { seedDefaults: { recordType: env.RECORDING_TYPE, transcribeEnabled: env.TRANSCRIBE, transcribeMode: parseTranscribeMode(process.env.TRANSCRIBE_MODE), autostopMinutes: env.AUTO_STOP_MINUTES } })` — CRITICAL (QA review #2): seed `transcribeMode` from RAW `process.env.TRANSCRIBE_MODE` via `parseTranscribeMode`, NOT from `env.TRANSCRIBE_MODE` and NOT `effectiveTranscribeMode(env)`. `loadEnv()` collapses the field to the effective value (env.js returns `effectiveTranscribeMode(env)` in its `TRANSCRIBE_MODE` field), so reading it off the env object re-introduces the baked-`'off'` bug this note warns against: for `TRANSCRIBE=false` deployments the row would seed `'off'`, and with no runtime mode command `/transcribe TRUE` could never enable transcription. Do NOT "fix" this by changing `loadEnv()`'s collapse in Task 1 — `src/index.js` currently depends on the collapsed value; changing it there would transiently regress the controller. `effectiveTranscribeMode` remains a free-function import in `env.js` — do NOT read it off the env object.
   - Startup Node-version guard (spec Risks promise): if `process.versions.node` is below 22.13 (unflagged `node:sqlite` landed in v22.13.0 — at 22.5 the module exists only behind `--experimental-sqlite`; alternatively feature-detect `typeof DatabaseSync === 'function'` after the import), exit with a loud error naming `node:sqlite`'s requirement before opening the DB.
   - `client.on(Events.GuildCreate, ...)` → `configStore.upsertGuild(guild.id)` + existing deploy; `GuildDelete` → existing `forget` only (rows are permanent by design).
   - Pass `configStore` into `createSessionController`.
   - Update `/record_type`, `/autostop`, `/transcribe` reply wording in the same commit: replace "resets to env on restart" caveats with "Stored per guild; persists across restarts." (this is the commit that makes the text true).
   - Update the startup log line: `Recording mode: RECORDING_TYPE=MASTER — master mix only (per-guild; /record_type changes it, persisted)`.
4. Run new tests — Expected: green.
5. Run: `npm test` — Expected: fully green. (The Task 1–3 RED window already closed at Task 3 step 5, per the header note; this step removes the last `index.js` remnant and restores the unconditional full-suite-green rule.)
6. Commit: `feat: persist per-guild config in SQLite, auto-register guilds on invite`

## Task 6: Docs — `.env.example`, README, SETUP, docker-compose

Objective: Every doc reflects the 2.0.0 surface. No runtime behavior changes — the only functional edit is the Dockerfile's `faster-whisper==1.2.1` pin (reproducible image builds; noted in the Task 7 CHANGELOG).

Files:
- Modify: `.env.example`, `README.md`, `SETUP.md`, `docker-compose.yml`, `Dockerfile` (comment update + faster-whisper pin, per step 4), `CHANGELOG.md` placeholder if convenient (final entry in Task 7).

Steps:
0. ~~Commit the planning artifacts (moved to Task 1 step 0 — commit `.project/` while the suite is still baseline-green; see Task 1).~~
1. `.env.example`: remove `SINGLE_FILE` block; add `RECORDING_TYPE=PER_USER` with comment (valid values, BOTH explicitly called out as "reserved, not yet supported"); add `DB_PATH` comment block ("SQLite database file for per-guild settings + guild ledger. Default when unset: <MEETINGS_DIR>/recorder.db. Under Docker, compose sets DB_PATH=/data/recorder.db (the recordings named volume) so settings persist across redeploys; see docker-compose.yml for the commented-out host-disk-file alternative — bind a host directory, never a single file (WAL creates -wal/-shm sidecars)."); keep `TRANSCRIBE`/`TRANSCRIBE_MODE` comments but update the deprecation note (`TRANSCRIBE` is no longer deprecated — it is the runtime toggle; `TRANSCRIBE_MODE` still decides what gets transcribed).
2. `README.md` + `SETUP.md`: update env tables and any `/singlefile` references to `/record_type`; document `/transcribe`, `/help`, persistence ("settings are stored in a SQLite DB and survive restarts"), and the precedence rule (transcription is off when `TRANSCRIBE=false` OR mode is `off`). Document the two DB storage options: default = `recordings` named volume (`/data/recorder.db`, persists across redeploys); alternative = host disk via the commented-out bind-mount example in docker-compose.yml (bind a directory, never a single file — WAL sidecars; chown to UID 1000 on Linux hosts so the container's `node` user can write).
3. `docker-compose.yml`: DEFAULT = volume. Add `DB_PATH: /data/recorder.db` to `environment:` (same pattern as `MEETINGS_DIR`) — this lands the DB inside the `recordings` named volume so it survives redeploys. Immediately below it, add a COMMENTED-OUT alternative showing the on-disk-file setup:
   ```yaml
   environment:
     MEETINGS_DIR: /data
     # Default: DB lives inside the `recordings` named volume (below) and
     # persists across redeploys alongside the recordings.
     DB_PATH: /data/recorder.db
     # ALTERNATIVE — keep the SQLite DB as a plain file on the host disk
     # (easy to back up / inspect with any sqlite3 client). Bind-mount a
     # host DIRECTORY — never a single file: WAL journaling creates
     # -wal/-shm sidecars next to the DB file — and point DB_PATH at it:
     # DB_PATH: /db/recorder.db
   volumes:
     - recordings:/data
     # - ./:/db        # uncomment together with the ALTERNATIVE DB_PATH
                       # (Linux hosts: chown the host dir to UID 1000 — the
                       # container runs as user `node`)
   ```
4. `Dockerfile`: update the `SINGLE_FILE=TRUE` comment on the ffmpeg install to reference `RECORDING_TYPE=MASTER`. While in the file, pin the transcription sidecar's Python dependency (currently unpinned — every rebuild can pull a different faster-whisper with breaking churn, e.g. 1.1.1 reverted VAD parameter naming): change `pip install --no-cache-dir faster-whisper` → `pip install --no-cache-dir faster-whisper==1.2.1` (latest stable, PyPI 2025-10-31; Python ≥3.9, bookworm's 3.11 is compatible; `transcribe.py`'s `WhisperModel`/`ctranslate2` surface is stable across 1.x). Leave `ffmpeg` (apt) floating — codec/security updates are desirable, and the app has a documented `.wav` fallback. npm deps need no change: `npm ci` installs from package-lock.json (exact versions verified in the lockfile), so builds are already reproducible.
5. Run: `npm test` — Expected: still green (docs only).
6. Commit: `docs: document RECORDING_TYPE, DB_PATH, and new slash commands for 2.0.0`

## Task 7: Version bump + CHANGELOG + full verification

Objective: Ship the release per AGENTS.md.

Files:
- Modify: `package.json` (`"version": "2.0.0"`), `CHANGELOG.md`

Steps:
1. `package.json` → `2.0.0`, and add an `engines` field (spec Risks: the repo has none today; `node:sqlite` is unflagged only from 22.13): `"engines": { "node": ">=22.13" }`. The Task 5 runtime version guard remains the loud failure path; this is the declarative pin (npm warns on install with a mismatched Node).
2. `CHANGELOG.md` new `## [2.0.0] - <today's date>` heading (must match package.json exactly) with:
   - **Changed (breaking):** `SINGLE_FILE` removed → `RECORDING_TYPE=PER_USER|MASTER`; startup fails with a rename hint if `SINGLE_FILE` is present. `/singlefile` → `/record_type`.
   - **Added:** `/transcribe`, `/help`, `/record` settings hint, SQLite persistence (`DB_PATH`), guild ledger, per-guild config isolation (call out the fixed cross-guild leak explicitly as a Fixed bullet).
   - **Changed (non-breaking):** Docker image pins `faster-whisper` to `1.2.1` for reproducible transcription-sidecar builds.
   - **Fixed:** settings resetting on restart; guild A's settings leaking into guild B on a shared bot.
3. Run full gates:
   - `npm test` — expected: exit 0, all suites green.
   - SINGLE_FILE rejection sanity: already covered by Task 1's env tests (no separate `node -e` script — agent sessions block `-e` flags on approval policy). Confirm via `node --test test/env.test.mjs` green, which includes the `SINGLE_FILE is no longer supported` case.
   - `git status` — expected: no `.env` or `discord-meetings/` staged.
4. Commit: `chore: release 2.0.0` (code + docs + version together, per AGENTS.md).
5. Build & publish (operator action or explicit request only): `./build-and-push.sh` → `pdebiss/discord-meeting-recorder:2.0.0` + `:latest`. **Do not push `:latest` without the version bump.**

## Task 8: Review and verification

Objective: Spec-compliance review, then code-quality review.

Steps:
1. Walk the acceptance criteria one by one against the code/tests:
   - [ ] Criterion 1: covered by Task 1 test (the `SINGLE_FILE` rejection case lives there).
   - [ ] Criterion 2: covered by Task 2 persistence test + Task 5 wiring test.
   - [ ] Criterion 3: covered by Task 3 leak test (two guilds, isolated configs).
   - [ ] Criterion 4: covered by Task 4 tests (`/help` contents, `/record` tip).
   - [ ] Criterion 5: covered by Task 5 ledger tests (insert, gap-gated rejoin increment, joinedAt preserved).
   - [ ] Criterion 6: covered by Task 6 + Task 7 (docs, version, changelog, clean git status).
2. Run `npm test` one final time; confirm exit code 0.
3. Review gates (superpowers:subagent-driven-development flow): first a **spec-compliance** review against `.project/specs/config-sqlite-overhaul.md` (every key decision implemented? nothing from Out-of-scope snuck in — especially no `BOTH` value anywhere, no guild component added to `sessionDir()`/recording paths, and the process-wide one-session rule unchanged), then a **code-quality** review (DI respected, no duplicated validation logic, prepared statements, `bot.js` glue thin).
4. Checkpoint: feature branch ready; merge/finish per superpowers:finishing-a-development-branch.

---

## Appendix: parked for v3.0.0 (not built by this plan)

Ideas surfaced during 2.0.0 planning, deliberately deferred with rationale in the spec's Out-of-scope section:

- **Guild-scoped recording directories** — `discord-meetings/<guildId>/meeting-<stamp>/` so multi-guild deployments never mix folders from different guilds (today: flat, timestamp-only, safe only because sessions are strictly sequential). Touches `sessionDir()`, transcript placement, and delivery attribution.
- **Per-guild concurrent sessions** — today a second `/record` is rejected process-wide ("Already recording"); lifting that per guild needs voice-pipeline isolation, disk/IO budgeting, and transcription sidecar serialization design.
- **`RECORDING_TYPE=BOTH`** — per-user tracks AND master mix in one session; needs two audio sinks, bigger delivery zips, and a transcription-target decision.

These are feature ideas only — no design work has been done. Each needs its own brainstorming + design pass (per superpowers-brainstorming) before any plan is written.
