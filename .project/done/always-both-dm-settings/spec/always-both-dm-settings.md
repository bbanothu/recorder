# Design: always-BOTH recording + per-guild DM settings (v3.0.0)

Status: **Approved** (user decisions 2026-09-22)

## Goal

Every session records **both** per-user tracks and the master mix (no recording
type to choose), transcription always runs against the per-user tracks, and each
guild controls — with a persisted `/dm` setting — whether `/stop` sends audio
files and whether it sends transcription files.

## Users / actors

- **Operator (single, self-hosted, multi-guild).** Records meetings in any guild
  the bot is in; gets one master mix + per-speaker tracks + one transcript; can
  silence either DM stream per guild (`/dm audio FALSE`, `/dm transcribe FALSE`)
  without losing the files on disk.
- **Meeting participants.** Unchanged: announcements, no audio of their own is
  DM'd to them.
- **Future archaeology / cleanup.** Recordings are attributable to a guild from
  the path alone: `<MEETINGS_DIR>/discord-meetings/<guildId>/meeting-<stamp>/`.

## Key decisions (user-approved)

1. **Always BOTH — `RECORDING_TYPE` is deleted** (env, `/record_type`, DB
   column). Every session captures per-user tracks *and* the master mix. The
   dual sink already exists and is a single boolean today (`recorder.js:32`
   `writePerUserFiles`, `bot.js:334-338,352-356` `masterOnly` → `master` +
   `writePerUserFiles: !masterOnly`), so this is a deletion, not new plumbing.
   **Loud cutover**: `RECORDING_TYPE` present in the environment → startup error
   naming the variable (same precedent as the 2.0.0 `SINGLE_FILE` rejection at
   `env.js:133-135`). No silent ignore — this repo's ethos is loud errors.
2. **Transcription always comes from the per-user tracks** (best accuracy:
   isolated per-speaker audio, no mix bleed) → exactly one
   speaker-attributed `transcript-<TS>.md` per session, the 1.7.0 combined
   route. Consequence: `TRANSCRIBE_MODE` (`combined|master|off`) is deleted
   (loud cutover error if set), and the **master-transcript route is removed**
   — which makes v2.1.0's speaking-log sidecar + attribution dead code (see
   decision 8).
3. **Per-guild DM settings, new `/dm` command.** Two booleans in `guild_config`,
   seeded `TRUE` (send everything). Configured only at runtime — **no env vars**,
   because this release's direction is a shrinking env surface. `TRUE`/`FALSE`
   string options with `addChoices` (the repo's existing idiom at
   `bot.js:66-79`), bare invocation views both, setting one leaves the other
   alone. Added to `/help` and to the `/record` settings tip.
4. **`/transcribe` and `/dm transcribe` are orthogonal, not duplicates**:
   - `/transcribe TRUE|FALSE` = **produce** the transcript file (off ⇒ no
     sidecar spawned, no file written — unchanged 1.6.0 semantics, pinned by
     `bot.js:598` `transcriptionOn`).
   - `/dm transcribe TRUE|FALSE` = **send** that file to the invoker's DMs.
   So `transcribe TRUE` + `dm transcribe FALSE` is the archive-without-DM state.
   Precedence: `/transcribe FALSE` wins (nothing is produced, so nothing is
   sent). Both are re-read at stop time, like today's transcribe gate
   (`bot.js:596-598`).
5. **Guild-scoped recording paths.**
   `<MEETINGS_DIR>/discord-meetings/<guildId>/meeting-<UTC stamp>/`.
   `sessionDir()` takes a required third argument, validated as a Discord
   snowflake (`/^\d{17,20}$/`) with a loud throw otherwise (a path segment that
   arrives from Discord must never be interpolated unchecked). Everything
   downstream already derives from the dir (`combinedTranscriptFileName(dir, …)`,
   the delivery path message), so nothing else changes shape. (The old
   `sessionZipPath` = `dir + '.zip'` is **gone as of 3.0.0** — Task 7 deleted
   `zipSession`, Task 8 removed `sessionZipPath` and the `yazl` dependency, so
   no path builds a zip any more.) `guildId` is threaded `bot.js` → `Recorder` opts →
   `sessionDir()`; the `Recorder` gains a `guildId` option.
6. **Legacy flat dirs are never migrated.** Existing
   `discord-meetings/meeting-<stamp>/` folders cannot be attributed to a guild
   retroactively (the `guilds` ledger has no meeting→guild mapping). They stay
   where they are and stay on disk untouched — no code path constructs the flat
   shape anymore, and nothing lists or serves them (there is no listing/serving
   feature anywhere in `src/`). Docs state the two-layout reality; a future
   cleanup job must scan both.
7. **Delivery: the master mix is the ONLY audio DM'd; the per-user tracks are
   never sent** (user decision 2026-09-26, revised from the original
   "both parts" design).
   - master → bare `.ogg` as a single-file DM (`Your meeting recording (master
     mix):`). It is mono 24 kbps ≈ 10.8 MB/h (`master-mix.js:192-212`), so it
     fits Discord's 25 MiB cap for ~2.4 h of recording; past that it falls back
     to the on-disk path message.
   - per-user tracks → **never DM'd, never zipped**: they stay on disk as the
     transcription input. Rationale: the tracks are the expensive artifact (raw
     forwarded stereo Opus, ≈21-29 MB/h *per speaking user*, so a 4-speaker 2 h
     meeting is ≈100 MB and routinely over the cap), and the archive is the
     product — delivery is a convenience. The reply names the directory. This
     also retires `zipSession` (no consumer left).
   - **A master that came back as `.wav` is NEVER DM'd** (`master-mix.js:145-151`
     keeps the WAV when ffmpeg fails; that file is stereo 48 kHz 16-bit —
     `writeWavFile(wavPath, pcm, { sampleRate, channels: CHANNELS /* 2 */ })` —
     ~11.5 MB/min, over the 25 MiB cap after ~2 minutes). It stays on disk and
     the reply says so. No startup ffmpeg probe is added: `master-mix.js:146-148`
     already logs the failure loudly per session, and the `/stop` reply names it.
   - Both parts are cap-checked independently; when a part cannot be sent the
     reply carries the on-disk path (reusing the existing
     `Files are at:\n\`<dir>\`` wording).
   - `audio = FALSE` → **no zip is built and no audio DM is attempted**; the
     reply is the path message. (No point paying the zip cost for a message
     that will not be sent.)
   - `delivered` becomes "at least one artifact reached the DMs"; a *suppressed*
     delivery must not read as a *failed* one in the `/stop` channel notice.
8. **Delete the now-dead master-transcript machinery** rather than leave it
   dormant: `src/attribution.js`, `src/speaking-log.js` and their tests, the
   `master-*.md` render route (`transcriptFileNameFor`,
   `renderTranscriptMarkdown`) and its tests, plus the `bot.js` seams that
   exist only for them (`createSpeakingLog`, `readSpeakingLog`,
   `speakingTouch`, `speakingAppendFile`, the `speakingStarts` map, the
   `speaking-log.jsonl` sidecar write). Verified single-purpose: every use is
   inside the `masterOnly` branch or the master transcript branch
   (`bot.js:26-27,185-218,362-438,664-696`).
   **`src/speaking-gate.js` is explicitly NOT in this list** — `SpeakingGate.onConfirmed`
   → `recorder.markConfirmed` (`bot.js:392-394` → `recorder.js:101-105`) sets the
   `confirmed` flag that `recorder.finalize` (`recorder.js:138-145`) requires before a
   per-user track is kept, so the gate's construction, `speakingStart`/`speakingEnd`
   wiring and `onConfirmed` survive; only its `onStopped` sidecar branch
   (`bot.js:374-391`) is deleted.
9. **Version 3.0.0** (breaking): env var removals, command removal, on-disk
   layout change, delivery behavior change, feature removal.
10. **Deferred, explicitly out of 3.0.0:** meeting stats/history table, the
    retention/cleanup job (and therefore anything that deletes audio), per-guild
    concurrent sessions, word-level timestamps / shared-mic diarization.

11. **Master-mix storage: a sparse temp file, not RAM** (user decision 2026-09-26,
    after the Task 3 quality review priced the always-BOTH cost). Measured:
    the in-RAM accumulator is a stereo `Float32Array` timeline indexed by
    absolute session offset — 48 kHz × 2ch × 4 B = 384 KB/s ≈ 23 MB/min
    ≈ **1.38 GB/h**, doubling transiently to ~2×, so a 2-hour meeting can
    demand ~2.8 GB and a late first speaker allocates in proportion to
    *elapsed* time. The mix therefore accumulates in `<dir>/master-<ts>.mix.tmp`
    (interleaved float32 stereo, so the summation math is unchanged) via
    positional read-modify-write, where unspoken time reads back as zeros;
    `finalize()` streams the temp through `softLimitToInt16` into the `.wav`,
    unlinks the temp **before** ffmpeg runs and again in a `finally`, and stale
    temps from a killed process are swept at startup. Shipped as `80fea8b` and
    **measured** on the target platform (synthetic 1-hour span, real ffmpeg,
    NTFS): peak heap **5.6 MB** (was ~1.38 GB), temp **1.38 GB/h**, WAV
    659 MiB/h, peak temp+WAV coexistence **1.93 GiB**, final `.ogg` **4.6 MiB**,
    `finalize()` ~37 s for that hour (ffmpeg on the WAV dominates), 0 temps
    left. Platform caveat: the gap is logically sparse (zeros on read) but
    **not physically** — NTFS zero-fills and allocates the full session-length
    size, so the temp's disk cost tracks session *length*, not speech, and is
    the same order as the RAM it replaced. ext4 punches a real hole. The win
    is RAM, not disk. Two operational assumptions ride with this: the startup
    sweep deletes every `*.mix.tmp` under `MEETINGS_DIR`, so **one bot instance
    per recordings root** (a second instance sharing the root would sweep the
    first's live temp); and the packet path is now **synchronous disk IO**
    (~16.7 us/packet, ~0.67% of the event loop at 8 speakers x 50 pkt/s —
    acceptable on local disk, but it sits inside the voice packet callback, so
    a stalling volume (network share, AV scanner) blocks receive handling for
    every user). Keep `MEETINGS_DIR` on local disk. Review-found defects fixed
    in `3f6c867`: a failed conversion used to leave a corrupt
    `master-<stamp>.wav` behind (now unlinked), `wav.js`'s `close()` used to
    skip `closeSync` when the header patch threw (now `try/finally`), and a
    failed post-encode unlink used to log "ffmpeg opus failed" and return the
    WAV while the `.ogg` existed (now a warning, `.ogg` returned). The memory
    pin was vacuous too — `heapUsed` excludes ArrayBuffer backing stores — and
    now measures `external`, failing 17x over budget against the pre-3b
    implementation. Rejected alternatives: chunked
    in-RAM window (same moving parts, no benefit), per-user PCM temp files
    (N × session-length disk), and a long-lived ffmpeg fed from stdin (right
    long-term shape, but it removes the `.wav` fallback and rewrites the
    packet-ordering policy — a 3.x follow-up). **Deferred with it:** the
    per-user `frames` array in `recorder.js` retains every Opus packet until
    `stop()` (~21 MB/h per user, ~380 MB for 6 users × 3 h) — the same pattern,
    an order of magnitude smaller; streaming `ogg-mux` is a later release.

## Behavior spec

### Environment (`src/env.js`)

`loadEnv()` return shape loses `RECORDING_TYPE` and `TRANSCRIBE_MODE`:

```
DISCORD_BOT_TOKEN, MEETINGS_DIR, GUILD_IDS, DB_PATH,
TRANSCRIBE (bool), WHISPER_MODEL, WHISPER_PYTHON, MASTER_BITRATE, AUTO_STOP_MINUTES
```

Cutover guards, both loud, both checked before required-var validation so the
operator sees the actionable message first:

```js
if (env.RECORDING_TYPE != null && String(env.RECORDING_TYPE).trim() !== '') {
  throw new Error(
    'RECORDING_TYPE is no longer supported. Every session now records per-user tracks AND the master mix.',
  );
}
if (env.TRANSCRIBE_MODE != null && String(env.TRANSCRIBE_MODE).trim() !== '') {
  throw new Error(
    'TRANSCRIBE_MODE is no longer supported. Transcription is controlled by TRANSCRIBE (or /transcribe) and always uses the per-user tracks.',
  );
}
```

`parseRecordingType` and `parseTranscribeMode`/`effectiveTranscribeMode` are
deleted. `parseBool`, `parseBitrate`, `parseWhisperModel`,
`parseAutoStopMinutes` are untouched.

### Seed defaults (`src/wiring.js`, `src/index.js`)

```js
buildSeedDefaults(env) // → { transcribeEnabled, dmAudioEnabled: true, dmTranscribeEnabled: true, autostopMinutes }
```

The second parameter (raw `process.env.TRANSCRIBE_MODE`) disappears from the
signature and from the `index.js:52` call site — the `effectiveTranscribeMode`
collapse dance that motivated it is gone. `index.js`'s `RECORDING_TYPE` mode
label (lines 95-98) is deleted.

### Config record + store (`src/db.js`)

```
{ transcribeEnabled: boolean, dmAudioEnabled: boolean, dmTranscribeEnabled: boolean, autostopMinutes: number }
```

`saveConfig` accepts any subset (existing partial-patch semantics). Boolean
validation for the two new fields uses the same loud-message style as
`validatePatchFields` (`transcribeEnabled must be boolean, got X`). The store
no longer imports anything from `env.js`.

### Slash commands (`src/bot.js`, `src/wiring.js`)

- Removed: `/record_type` (builder, handler `recordType`, `DISPATCH_HANDLERS`
  entry, the `recordType` seed dep in `createSessionController`).
- Added: `/dm` with two optional `TRUE|FALSE` string options:

  ```js
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Show or set what /stop sends to your DMs')
    .addStringOption((opt) => opt.setName('audio')
      .setDescription('Send audio files on /stop; omit to leave unchanged')
      .setRequired(false).addChoices({name:'TRUE',value:'TRUE'},{name:'FALSE',value:'FALSE'}))
    .addStringOption((opt) => opt.setName('transcribe')
      .setDescription('Send transcript files on /stop; omit to leave unchanged')
      .setRequired(false).addChoices({name:'TRUE',value:'TRUE'},{name:'FALSE',value:'FALSE'}))
    .toJSON(),
  ```

  - bare → view: `` DM settings — audio: **TRUE**, transcript: **TRUE**.
    `/dm audio FALSE` stops audio DMs, `/dm transcribe FALSE` stops transcript
    DMs (files stay on disk). Stored per guild; persists across restarts. ``
  - any option given → validate, `saveConfig`, confirm the resulting effective
    state (both values), same "stored per guild; persists across restarts" tail
    as `/transcribe` (`bot.js:832-837`).
  - invalid value string → `` Audio must be `TRUE` or `FALSE` (or omit to view). ``
- `/record` tip becomes: ``Tip: /autostop, /transcribe, /dm change settings; /help lists everything.``
- `buildHelpText()`: `/record_type` line removed, `/dm` line added
  (`/dm` — Show or set what /stop sends to your DMs. Example: `/dm audio FALSE`).
- Unknown-command hint (`wiring.js:105`): the `/singlefile` tip is replaced by
  `` `/record_type` was removed in 3.0.0 — recording type is always both. ``

### Recording (`src/recorder.js`, `src/session.js`, `src/bot.js`)

- `Recorder` gains `guildId` (constructor opt) and passes it to
  `sessionDir(this.meetingsRoot, this.startedAt, this.guildId)`.
- `sessionDir(meetingsRoot, startedAt, guildId)` validates
  `/^\d{17,20}$/` (throw naming the value) and creates
  `join(meetingsRoot, 'discord-meetings', guildId, 'meeting-<stamp>')`.
- `bot.js` `record()`: `const master = deps.createMasterMix?.() ?? new MasterMix({...})`
  (unconditional), `writePerUserFiles: true`. `masterOnly` disappears entirely.

### Transcription at stop (`src/bot.js`)

- Targets = confirmed per-user tracks from `result.userFiles`, `≥ MIN_TRACK_FRAMES`,
  deduped by path, sorted deterministically (all existing logic at
  `bot.js:600-644` stays — only the `mode` branches go).
- Gate: `stopConfig.transcribeEnabled` (stop-time re-read preserved).
- Render: `renderCombinedTranscriptMarkdown` → `combinedTranscriptFileName(result.dir, …)`
  → `transcribeWriteFile` (unchanged).
- DM: only when `stopConfig.dmTranscribeEnabled`; the file is written either
  way. Log line distinguishes both cases:
  `transcript delivered → <name> (N segments, M speakers)` vs
  `transcript written → <name> (DM off via /dm transcribe FALSE)`.

### Delivery (`src/deliver.js`, called from `bot.js` `stopSession`)

New signature (replaces the single `files` array):

```js
deliverSession({
  interaction, invokerId, dir, auto,
  userFiles,        // string[] absolute .ogg paths (per-user tracks)
  masterFile,       // string | null (master .ogg, or a .wav when ffmpeg failed)
  sendAudio,        // boolean — the guild's dmAudioEnabled
  notify, dmInvoker, maxUploadBytes = MAX_UPLOAD_BYTES,
}) → { delivered, suppressed }
```

Rules, in order (the order is load-bearing):

1. **No audio at all** (`userFiles` is empty **and** `masterFile` is null) →
   the existing "Nobody spoke" reply, `{ delivered: false }`. This runs
   **first**: with no audio there is nothing to suppress, so an audio-off guild
   with an empty session gets `{ delivered: false }`, not `suppressed: true`.
2. `sendAudio === false` → reply
   `` `${verb}. Audio DMs are off (/dm audio TRUE to re-enable). Files are at:\n\`${dir}\`` `
   → `{ delivered: false, suppressed: true }`. No zip built, no DM attempted.
3. Master: DM it alone when `masterFile` ends in `.ogg` and its size ≤ cap
   (content `Your meeting recording (master mix):`). Otherwise skip it with a
   reason: oversize → `The master mix is too large for Discord and stays on disk.`;
   non-`.ogg` → `The master mix was kept as .wav (ffmpeg unavailable) and was not sent.`
4. Tracks: exactly one and ≤ cap → bare `.ogg`
   (content `Your meeting recording:`); otherwise zip → DM when ≤ cap
   (content `Meeting recording (N track file(s)):`); oversize →
   `The tracks archive is too large for Discord (N bytes) — files are at:\n\`${dir}\``.
5. **Per-part forbidden DM (50007).** The two parts are independent sends, so a
   closed-DM failure on one part must not abort the other. A part whose send
   throws a forbidden-DM error is skipped with the existing
   `Could not DM <part>. Files are at:\n\`${dir}\`` shape (reuse `isForbiddenDm`);
   the other part is still attempted and reported.
6. Reply summary: `${verb}. Sent <parts> to your DMs.` with `<parts>` =
   `the master mix`, `the per-user tracks`, or `the master mix and the per-user tracks`,
   plus any skip sentences from rules 3-5. If nothing was sent:
   `${verb}. Nothing was sent — files are at:\n\`${dir}\``.
7. `delivered` = at least one DM (either part) succeeded. `suppressed` = true
   only for rule 2.

`bot.js`'s channel-notice tail (`bot.js:570-581`) gains a suppressed case:
suppressed → `Files kept on disk (audio DMs are off).`, else unchanged.

### Data model / migration

```sql
-- guilds: unchanged
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id              TEXT PRIMARY KEY REFERENCES guilds(guild_id),
  transcribe_enabled    INTEGER NOT NULL,
  dm_audio_enabled      INTEGER NOT NULL DEFAULT 1,
  dm_transcribe_enabled INTEGER NOT NULL DEFAULT 1,
  autostop_minutes      INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
);
```

v1 → v2 migration, everything inside `initSchema` and idempotent:

1. Read the existing column list with the proven prepare form:
   `db.prepare("PRAGMA table_info('guild_config')").all()` (verified on the
   project runtime — Node 26.7.0 / SQLite 3.53.4; the same prepare-a-pragma form
   is already exercised at `test/db.test.mjs:245`). No `SELECT * FROM pragma_…`
   fallback.
2. `CREATE TABLE IF NOT EXISTS …` with the v2 shape (no-op on a legacy table).
3. Column-presence guards — this is the whole migration, and it is safe on a
   fresh DB because every guard no-ops there:
   - `record_type` present → `ALTER TABLE guild_config DROP COLUMN record_type`
   - `transcribe_mode` present → `ALTER TABLE guild_config DROP COLUMN transcribe_mode`
   - `dm_audio_enabled` absent → `ALTER TABLE guild_config ADD COLUMN dm_audio_enabled INTEGER NOT NULL DEFAULT 1`
   - `dm_transcribe_enabled` absent → `ALTER TABLE guild_config ADD COLUMN dm_transcribe_enabled INTEGER NOT NULL DEFAULT 1`
   (`ALTER TABLE … DROP COLUMN` needs SQLite ≥ 3.35; verified available on the
   project runtime — SQLite 3.53.4 under Node 26.7.0, and the Node floor is
   ≥ 22.13 which bundles ≥ 3.46. Task 9 prints the runtime's `sqlite_version()`
   once and records it next to the measured master-mix size, so the claim is
   attested on the shipped runtime rather than assumed.)
4. `PRAGMA user_version = 2` (read back with
   `db.prepare('PRAGMA user_version').get().user_version`; the prepare-a-pragma
   form is proven on this runtime, `test/db.test.mjs:245`).

Existing rows keep `transcribe_enabled` / `autostop_minutes` / `updated_at`;
the two new toggles materialize as `1` (send). No row is lost or re-seeded.

## Out of scope

- **Meeting stats / history table** and the **retention-cleanup job** — the
  cleanup job deletes audio *and* transcripts by age, so it must not ship before
  a stats table exists (history loss is unrecoverable). Both deferred.
- **Per-guild concurrent sessions** — still one session process-wide
  (`bot.js:130` + the "Already recording" guard). Guild-scoped paths make it
  safe later; they do not ship it.
- Word-level timestamps, shared-mic diarization (README "Future" list — note the
  master-track diarization rationale changes now that master transcripts are
  gone; leave the notes section accurate and brief).
- Migrating or re-homing legacy flat `meeting-<stamp>/` directories.
- Any env var for the DM toggles.

## Acceptance criteria

1. Startup with `RECORDING_TYPE` set → error naming `RECORDING_TYPE` and the new
   always-both behavior; startup with `TRANSCRIBE_MODE` set → error naming it.
   Neither is silently ignored; `SINGLE_FILE` keeps its existing rejection.
2. Every session — no setting anywhere — writes per-user tracks **and**
   `master-<ts>.ogg`, all under
   `<MEETINGS_DIR>/discord-meetings/<guildId>/meeting-<UTC stamp>/`.
3. `sessionDir()` throws (naming the value) on a guild id that is not
   `^\d{17,20}$`; the real recorder passes `interaction.guildId` through.
4. `/record_type` no longer exists (registry, dispatch table, help text, and
   unknown-command hint all agree); `/dm` exists in the registry and in `/help`;
   the `/record` reply tip names `/dm`.
5. `/dm` bare shows both toggles; `/dm audio FALSE` and
   `/dm transcribe FALSE` each persist per guild across a process restart
   (DB read-back test) and never affect another guild.
6. `/dm transcribe FALSE` still writes `transcript-<TS>.md` to disk but sends no
   transcript DM; `/transcribe FALSE` produces no file at all.
7. Transcription target is always the per-user tracks (one combined
   speaker-attributed transcript); no `master-*.md` is ever produced, and
   `src/attribution.js` / `src/speaking-log.js` no longer exist.
8. Delivery: the master mix (bare `.ogg`) is DM'd and is the ONLY thing DM'd;
   a `.wav` master or an oversize master is never sent and the reply names the
   on-disk path; per-user tracks are never DM'd or zipped (they stay on disk for
   transcription) and no zip is ever built; `/dm audio FALSE` sends nothing and
   returns the path; the `/stop` channel notice says the files were kept, not
   that delivery failed.
9. `PRAGMA user_version` is 2; a v1-format DB (legacy columns + a row) migrates
   in place with `transcribe_enabled`/`autostop_minutes` intact and both new
   toggles = 1; a fresh DB gets the v2 schema.
10. Legacy flat `meeting-<stamp>/` dirs are not migrated and remain on disk
    untouched; no code path constructs that flat shape anymore; docs state the
    two-layout reality.
11. `npm test` exit 0; `.env.example`, README, SETUP updated; `package.json`
    `3.0.0`; CHANGELOG `## [3.0.0] - <date>` matching exactly.
12. Building the master mix allocates **no session-length buffer**: for a
    synthetic 30+ minute-span session with sparse packets the accumulator's
    resident footprint stays flat and its temp file's size tracks the highest
    written offset rather than elapsed time; the temp file is removed after
    `finalize()` (success *and* failure) and is deleted as soon as the WAV
    conversion completes, so temp and WAV are not both resident longer than
    necessary; **stale `*.mix.tmp` files left by a crashed process are deleted
    at startup** (no session can be live then); and for a short deterministic
    fixture the produced WAV bytes are **identical** to the pre-3b in-RAM
    implementation's.

## Risks / tradeoffs

- **Disk roughly doubles per meeting** (raw forwarded stereo tracks + mono
  24 kbps master), and the session's own temp file is a third copy while it
  runs (1.38 GB/h, unlinked before the encode). Accepted: the recording is the
  product; the temp is transient and swept; retention/cleanup is a later
  release.
- **Master `.ogg` size — measured, not arithmetic (Task 9).** 60 s of synthesized
  speech encoded through the real `buildFfmpegArgs` at the default `24k` (mono,
  voip) on the shipped runtime (Node 26.7.0 / SQLite 3.53.4, ffmpeg 9.0.1)
  produced **183,577 bytes/min ≈ 11.0 MB/h (10.5 MiB/h)** — within ~2% of the
  ≈10.8 MB/h nominal figure in decision 7, so that estimate stands and the
  25 MiB cap still covers ~2.4 h of continuous speech. Opus VBR tracks content:
  the same run gave 15.1 MB/h for a pure 220 Hz tone and 9.4 MB/h for pink
  noise, so tonal input can overshoot the nominal bitrate (decision 7's
  "continuous-audio worst case" caveat) while speech — what the mix actually
  carries — lands on the estimate.
- **The audio packet path touches disk synchronously.** Task 3b replaced the
  in-RAM mix with positional read+write per packet (~16.7 us, measured): cheap,
  but it runs inside the voice `onPacket` callback, so the failure mode is now
  "a slow disk stalls all receive handling" rather than "a big meeting runs
  out of RAM". Local disk only — do not point `MEETINGS_DIR` at a network
  share or a folder an AV scanner watches, and expect `/stop` to spend ~37 s
  encoding the master for a 1-hour meeting.
- **ffmpeg is now on every session's path.** Without it every session also
  leaves a stereo `.wav` (≈11.5 MB/min) on disk that is never DM'd. Accepted,
  logged loudly by `master-mix.js`, and named in the `/stop` reply.
- **RAM: the master mix used to hold the whole session in memory.** Found by
  the Task 3 quality review, after the plan was approved: the mix is a stereo
  `Float32Array` timeline at ~23 MB/min (~1.38 GB/h, ~2.8 GB peak with growth),
  and always-BOTH made it universal instead of MASTER-only. A long meeting — or
  simply a first speaker who joins late, since the offset is proportional to
  elapsed time — demanded an unbounded allocation, and the resulting
  `RangeError` escaped the voice packet callback into the process. Review
  decisions 2026-09-26: `186b95d` isolated the failure (a mix fault can no
  longer abort `/stop` or kill the bot) and decision 11 / AC12 remove the
  trigger by accumulating into a temp file on disk (decision 11). Measured
  after `80fea8b`: peak heap 5.6 MB, temp 1.38 GB/h of *disk* for the duration
  of the session (unlinked before ffmpeg), WAV 659 MiB/h, final `.ogg` 4.6 MiB.
  Residual: the temp's disk cost is identical to the RAM it replaced on NTFS
  (holes are not physical there), so this trades RAM pressure for disk
  pressure — on a host whose recordings volume is small, a 2-hour meeting
  needs ~1.4 GB free while it runs, and `finalize()` blocks `/stop` for tens of
  seconds on the encode. Both are documented, not solved; the structural fix
  (a long-lived ffmpeg fed from stdin, no temp and no stop-time burst) remains
  the 3.x follow-up named in decision 11.
- **CPU: opusscript now decodes on every session.** `MasterMix.push` decodes
  every packet via opusscript (`master-mix.js:76-114`); today that only runs in
  MASTER mode, but always-BOTH makes it universal, adding decode cost to every
  recording. No code change — budget host headroom (the same advice as
  `WHISPER_CPU_THREADS`) and note it in the release docs if load matters.
- **The per-user tracks are the real disk consumer and have no cleanup job.**
  Raw forwarded stereo Opus at ≈21-29 MB/h *per speaking user*: a 4-speaker 2 h
  meeting is ≈100-230 MB, and they are never DM'd (decision 7), so they simply
  accumulate under `discord-meetings/<guildId>/`. The retention/cleanup job is
  deferred and must not ship before the stats table exists (history loss). This
  release documents the growth rate instead of bounding it.
- **Layout change breaks external tooling** that reads the flat
  `discord-meetings/` path. Documented; no compatibility shim.
- **Feature removal:** master transcripts and best-effort speaker attribution on
  the mix (v2.1.0's work) go away. The user-facing transcript improves (it now
  always comes from isolated per-speaker audio), but the CHANGELOG says
  `Removed` plainly.
- **Two transcription switches** (`/transcribe`, `/dm transcribe`) can confuse;
  mitigated by both printing the other in their view output and by the help text
  phrasing ("produce" vs "send").
- **Ordering:** the DB column drop and the env removal must land in the same
  release — a half-applied migration would leave the store writing a column the
  schema dropped.