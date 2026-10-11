# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Verified
- On-device transcription actually works, confirmed on a real native Android build (`npx expo run:android`, Pixel 9 emulator) rather than reasoned about from source: downloaded the model, recorded, clipped, and watched whisper.rn (`RNWhisper: Loaded native library`, real job IDs in logcat) decode and transcribe a chunk with zero crashes — `_language: en_` / `[BLANK_AUDIO]` for the emulator's silent mic, exactly the correct output for no speech. First real confirmation of this pipeline anywhere in this project; Android has no signing/provisioning story to fight, unlike iOS.
- Clip size display, edit, redo, and delete-audio/delete-text (below) verified live on the same native Android build: watched real computed sizes render in Saved Clips, typed a manual edit and confirmed Save persisted it, deleted a clip's audio and confirmed the transcript froze in place while the size dropped to 0 B, then deleted its text too and confirmed the screen correctly fell back to "No transcript yet." Caught and fixed two real bugs in the process (see Fixed) that unit tests alone had not — both only surfaced by actually tapping the buttons.

### Added
- Phone app: clip storage sizes, editing, redoing, and deleting audio/text independently of the whole clip. Saved Clips and the clip detail screen now show real on-disk sizes (`formatBytes` in `mobile/src/core/format.js`); the detail screen gets `Edit` (manual transcript edit, overrides the live render from then on), `Redo` (re-transcribe from kept audio, discarding edits/cached translation), `Delete audio` (freezes the current transcript and removes the audio — nothing left to redo from), and `Delete text` (clears the transcript, audio stays, re-transcribable). Server: `getClip`/`listClips` now report `mdSizeBytes`/`audioSizeBytes` (`src/phone/service.js`), plus `redoClip`, `updateClipMarkdown`, `deleteClipAudio`, `deleteClipText` behind new routes (`POST .../redo`, `PUT .../transcript`, `DELETE .../audio`, `DELETE .../transcript` in `src/phone/http.js`). Local: `localClipSizes`, `updateLocalClipTranscript`, `redoLocalClip`, `deleteLocalClipAudio`, `deleteLocalClipTranscript` (`mobile/src/native/local-clips.js`, `mobile/src/native/ondevice-transcribe.js`) use a `edited.md` sidecar as both the manual-edit override and the permanent snapshot left behind once audio's gone — no new on-device storage needed beyond the filesystem already in place.
- Phone app: a "Transcribe locally" switch in Settings (On server / Locally). Locally skips the server entirely — no upload, no network call, no laptop dependency — and Clip goes straight to the on-device clip, transcribing in the background when this build actually has the native modules (`nativeTranscriptionAvailable()`, now also exposed on the recorder context for the UI to check). On server (default, unchanged) keeps today's behavior: prefer the server, fall back to local only if it fails. Verified for real on a native Android build (see below) — not just that the toggle flips, that the underlying on-device pipeline it switches to actually produces a transcript.
- Phone app: translate a non-English clip to English. Whisper does this directly from audio (its own `translate` task, not a text-translation pass over the existing transcript) — a new server endpoint (`POST /v1/devices/:id/clips/:clipId/translate`) runs it against the clip's kept audio and caches the result (`clips.translated_md_path`, `store.setClipTranslation`; migrated in for existing phone.db files via the same `PRAGMA table_info` + `ALTER TABLE` pattern `src/db.js` already uses), so reopening a clip or asking again never re-runs Whisper. An already-English clip (`clips.language`, now persisted — was previously only embedded in the markdown text) reuses its own transcript instead of translating-to-itself. On the clip screen: a "Convert to English" button on any non-English clip; once translated, the English text and the original are both shown, each separately shareable. Verified the real `faster_whisper` `task="translate"` call end to end, not just mocked.

### Changed
- Phone clip transcript filenames: `clip_MM-DD-YYYY_HHMM-HHMM-UTC.md` (e.g. `clip_10-10-2026_1533-1548-UTC.md`) instead of `transcript-YYYY-MM-DD_HH-MM.md` — month/day/year and the clip's whole time range, not just a start stamp, both in UTC. New `clipTranscriptFileName` in `src/transcribe.js` (server-written files) and `mobile/src/core/local-transcript.js` (what a shared/downloaded transcript is named from the app) — independent, same convention; mobile can't import the server package. Scoped to phone clips only: the Discord bot's and notetaker's `transcript-<TS>.md` session files are unrelated and unchanged.

### Added
- Phone app: delete clips. Saved Clips now has a "Delete" per clip and a "Delete all" above the list, both behind a confirm dialog, for local and server clips alike. Server: `DELETE /v1/devices/:id/clips/:clipId` (one) and `DELETE /v1/devices/:id/clips` (all), removing the clip's row and its files (`src/phone/service.js` `deleteClip`/`deleteAllClips`, `store.js` `deleteClip`). Local: `deleteLocalClip`/`deleteAllLocalClips` (`mobile/src/native/local-clips.js`) remove the clip's folder and its `clips-store` row.
- Phone app: a default server (`mobile/src/native/RecorderContext.js`'s `DEFAULT_SERVER`) so Clip gets a real cloud/server transcript out of the box, no Settings step — a stopgap while on-device transcription still needs a dev-client build. Sourced from `EXPO_PUBLIC_PHONE_SERVER_URL` / `EXPO_PUBLIC_PHONE_TOKEN` build-time env vars (`mobile/.env.local`, gitignored; `mobile/.env.local.example` is the committed template) rather than hardcoded in source, since those get inlined into the built app — only applies until Settings is saved once, after which the user's own value always wins. `faster-whisper` is now installed for the phone-server's Whisper sidecar (`.env`, gitignored, has `PHONE_TOKEN`/`PHONE_BIND`/`WHISPER_PYTHON` for it) — verified end to end against a real run of the server (health + an authenticated request both answered), not just configured; the user is running the server themselves from here. ffmpeg (needed for the server's transcode/concat step) is installed too. Verified end to end for real: a clip recorded on the phone came back as a 48-segment transcript written by faster-whisper on the laptop.
- Phone app: dark mode. `mobile/src/native/ui.js` now has a light/dark color palette picked via `useColorScheme()` (`useTheme()` hook), covering every screen; the native header bar/status bar follow the system setting too (`expo-router`'s `ThemeProvider`, which otherwise always defaults to light regardless of the system). `app.json`'s `userInterfaceStyle` changed from `light` to `automatic`.

### Fixed
- Phone app: `clips/[id].js` imported `deleteLocalClipAudio` from `local-clips.js`, where it's never defined — it actually lives in `ondevice-transcribe.js` — so the import silently resolved to `undefined` and tapping "Delete audio" on a local clip crashed the whole app (`undefined is not a function`). Unit tests never caught it since the module-level function itself was correctly implemented and tested; only live-tapping the button on a real build surfaced the mismatched import.
- Phone app (local clips): once a clip's audio *and* text were both deleted, the live transcript render (`renderClipMarkdown` over zero chunks) still produced a header-only `# Clip transcript\n_language: unknown_` instead of nothing, so the screen never fell back to "No transcript yet." and a useless "Delete text" button lingered. `getClipTranscript` (`mobile/src/native/ondevice-transcribe.js`) now returns `markdown: null` when there are no chunks and no saved edit left to show.
- Phone app: an **uncaught** `AudioApiError: ... native module could not be found` could take the whole app down. `react-native-audio-api` does `export default new AudioAPIModule()` and that constructor throws when the native binding is missing; under Metro's async require the throw escaped the `try`/`catch` around the dynamic import (`importAll` → `tryCallOne`) rather than failing one chunk. Both native modules are now probed first via `TurboModuleRegistry.get` (the same call they use internally, which returns null instead of throwing) and never imported at all in a build that can't support them — so Expo Go simply skips on-device transcription instead of crashing or writing a "failed" sidecar per chunk.
- Phone server: every `Clip` is now also a retry — any chunk in the range whose transcription failed before goes back in the queue (`requeueFailedChunk`). A failure was previously permanent: a chunk that failed once contributed nothing to that clip and every later clip over the same audio, with no way to ask for another attempt.
- Phone app: `Clip` navigated straight to the local (on-device) clip every time, which — without a dev-client build — always shows the native-module-missing error, even though a separate, working server-backed clip was also being created in the background. Confusing: it looked like transcription was broken even when the server path was working fine. Now, when a server is configured (the common case, via the default-server stopgap), Clip waits for and navigates to the server clip instead — the one that actually produces a transcript today — falling back to the local clip only if the server fails or isn't configured. The local copy still always saves in the background either way.
- Phone app: a chunk whose transcription failed was stuck that way forever — once a sidecar existed at all, the resumable queue treated it as done and never looked at it again, so a transient or now-fixed failure (e.g. "native module could not be found", from before a dev-client build existed) kept showing the same stale error indefinitely. `needsTranscription()` (`mobile/src/core/local-transcript.js`) now treats an error sidecar the same as no sidecar — every `transcribeClip()` call (a new Clip, or just reopening a clip screen) retries anything that hasn't actually succeeded yet.
- Verified `react-native-audio-api` and `whisper.rn` actually link and the app launches clean on a real native build (`npx expo prebuild` + `npx expo run:ios` against the iOS Simulator, once Xcode's license was accepted) — no more guessing from source alone. `mobile/package.json`'s `ios`/`android` scripts updated to `expo run:*` by prebuild itself.
- Phone server: `sweep()` could delete a chunk's audio file before its (still-queued or slow) transcription ever ran, since retention only protected chunks a pending clip needed — not chunks still waiting in the transcription queue. A phone uploads whatever backlog it has (hourly, or right before a Clip), and `receiveChunk` never rejected an already-stale `startedAt`, so a chunk could arrive outside the window and lose the race against the next sweep: `Error opening input file ... No such file or directory`. Found on a real run against the user's own phone-server log, reproduced with a test, fixed by skipping chunks still in `state: 'received'` until they've had their chance.
- Transcription (bot, notetaker, and the phone-server stopgap alike): a bare `pip install faster-whisper` grabs the newest PyAV, which dropped the `metadata_errors` keyword `av.open()` is called with — every transcription failed with `TypeError: open() got an unexpected keyword argument 'metadata_errors'`. Found by actually running the real transcription pipeline end to end against a test file, not just checking that `ffmpeg`/`faster-whisper` were installed. `av<15` is now pinned alongside `faster-whisper` everywhere it's installed (Dockerfile, SETUP.md) — the Docker image happened to avoid this only because its base image predates PyAV 15.

### Added
- Invite notetaker preview (`npm run notetaker`, a separate process from the Discord bot): watches a mailbox (Zoho IMAP, opened read-only) for Google Meet and Zoom calendar invites and keeps a schedule in its own SQLite file (`NOTETAKER_DB_PATH`). It handles updated invites (`SEQUENCE`), cancellations, and recurring series (next occurrence, `EXDATE` skipped). Only organizers in `NOTETAKER_ALLOWED_ORGANIZERS` are scheduled. Joining is not built yet; a due meeting is logged as `would join`. New env vars: `NOTETAKER_EMAIL`, `NOTETAKER_APP_PASSWORD`, `NOTETAKER_ALLOWED_ORGANIZERS`, `NOTETAKER_BOT_NAME`, `NOTETAKER_IMAP_HOST`, `NOTETAKER_IMAP_PORT`, `NOTETAKER_DB_PATH`, `NOTETAKER_POLL_SECONDS`, `NOTETAKER_LOOKBACK_DAYS`.
- Notetaker Google Meet joiner: a minute before a scheduled Meet starts, Chrome (via `playwright-core`) joins with the bot's profile, waits to be admitted, posts a recording notice in the chat and turns on captions. The call audio plays into a private PulseAudio sink that ffmpeg records as mono voip Opus (`mix-<stamp>.ogg`). The bot leaves after 2 min alone, 30 min past the scheduled end, or 4 h. The transcript is Whisper's text with speakers taken from Meet's captions (each segment goes to whoever's captions grew most during it), or the captions alone when Whisper is unavailable. One meeting at a time; a meeting cut off by a restart is rejoined. New: `npm run notetaker:login` (one-time Google sign-in), `npm run notetaker:join -- <link>` (join now, for testing) and `npm run notetaker:relabel -- <meeting dir>` (rebuild a transcript's speakers from the saved `whisper-<stamp>.json` and captions, no re-transcription). New env vars: `NOTETAKER_ADMIT_TIMEOUT_MIN`, `NOTETAKER_BROWSER_PROFILE`, `NOTETAKER_CHROME_PATH`, `NOTETAKER_HEADLESS`; `WHISPER_MODEL` / `WHISPER_PYTHON` now also apply to the notetaker.

- Phone recorder server (`npm run phone-server`, preview): receives 1-minute audio chunks from the upcoming phone app, transcribes each with the Whisper sidecar, and on request keeps a clip of any range still in the window (`transcript-….md` plus the joined audio). Everything else older than the phone's window is deleted, audio and transcripts alike. Bearer-token auth; binds to loopback unless `PHONE_BIND` is set (meant for a Tailscale address). Phone app (`mobile/`, Expo SDK 57, iOS + Android, preview): records in 1-minute AAC files while open, uploads hourly and before every clip, keeps only the chosen window on the phone, and shows and shares clip transcripts. The app also runs in a browser (`npm run web` in `mobile/`): settings in localStorage, pending minutes in IndexedDB, transcripts download instead of share; the server answers CORS preflights for it. New env vars: `PHONE_TOKEN`, `PHONE_BIND`, `PHONE_PORT`, `PHONE_DB_PATH`, `PHONE_DEFAULT_WINDOW_MINUTES`, `PHONE_MAX_CHUNK_MB`.
- Phone app: clipping no longer needs the server (spec: `.project/specs/phone-recorder-on-device.md`). `Clip` now always saves its own copy of the window's audio on the phone first (`expo-sqlite`-tracked, listed under Saved clips with no setup), and only *also* offloads to a configured server for transcription, best-effort, if one is set — Settings relabels the server fields as optional. The Home screen also nudges after 3h of continuous recording to clip and stop. Web is unchanged (still server-required) — `expo-sqlite`/local-clip code is swapped out for a no-op on that platform.
- Phone app: on-device transcription, started. A local clip now runs a resumable per-chunk Whisper queue right on the phone (`whisper.rn`; resumability is just "does this chunk have a `.segments.json` sidecar yet" — an app kill mid-clip resumes by re-scanning, no separate queue table) and the clip screen renders the stitched transcript live as it fills in, polling while any chunk is still pending; a "Download model" button on the clip screen fetches `ggml-tiny.en.bin` (~75 MB, once) when missing. The AAC-to-WAV decode step (`whisper.rn` needs 16-bit PCM WAV; it doesn't decode AAC/M4A itself) is now implemented too, via `react-native-audio-api`'s `decodeAudioData` — confirmed against both libraries' own installed source, not guessed. Added a `metro.config.js` aliasing the `buffer` polyfill — whisper.rn's `safe-buffer` dependency does `require('buffer')`, which broke the Metro bundle for every platform (including web) until aliased; verified fixed by re-bundling. **Known gap:** `react-native-audio-api` installs its native binding at import time and throws immediately if it's missing, unlike whisper.rn — a static import of it crashed every screen in Expo Go, not just transcription (caught by re-bundling against the live dev server, not assumed); fixed with a dynamic `import()` scoped to the one function that needs it, so now only an actual transcribe attempt fails, gracefully, per chunk. Both libraries are native modules either way: nothing here can actually produce a transcript until a dev-client build exists (`npx expo prebuild`), which this sandbox has no simulator/emulator to run and verify end to end.

### Changed
- Transcript building (transcribe each track → combined `transcript-<TS>.md`) moved from `bot.js` into `src/transcript-pipeline.js` so the notetaker can reuse it. Discord behavior and log lines are unchanged.

## [3.0.2] - 2026-10-04

### Fixed
- A single undecodable Opus packet no longer poisons a per-user track: the track keeps only packets the session's decoder accepted, so the transcription reader (PyAV) no longer stops at the first bad packet and returns an empty transcript for that speaker.
- Captured tracks are never deleted. The speaking gate is now log-only; anyone who emitted audio keeps their file and reaches the transcript.
- Transcript timestamps are true: gaps in a user's packets are filled with a shared libopus silence frame on the 20 ms grid, so `startedAtMs + segment.start` lands on the meeting clock instead of drifting early.
- A per-user stream that errors or closes no longer risks an unhandled `error`; it is logged, its audio so far is kept, and the next time that user speaks a fresh subscription is opened.

### Added
- `timeline-<stamp>.jsonl` in each session directory: append-only record of session start, each track, speech bursts, and leave/reconnect events.
- Transcripts name a speaker with no recognized speech (`_No speech recognized for **name** (file)._`) and note a name that spans several tracks after a rejoin.
- `test/scripts/transcribe-track-recovery.test.sh` and a poison-packet fixture.

### Changed
- Per-user tracks now carry the full timeline (silence filled): about 31 B per 20 ms of silence, roughly 5.3 MB per speaker-hour.
- The near-empty-track skip counts speech frames (`speechFrames < 100`), not padded frames.
- Transcription first canonicalises each track through ffmpeg to a 16 kHz mono WAV (`<track>.transcribe.tmp.wav`, removed after use and swept at startup); decode errors ffmpeg recovers from are counted in the log.
- The stop-time summary reads `(N segments, M tracks, K with speech)` and logs per-track segment counts.

## [3.0.1] - 2026-09-27

### Fixed
- Transcript entries collapsed onto one line in Discord's markdown preview: a single newline is a *soft* break, so every timestamp ran together until the file was downloaded. Entries are now separated by a **blank line**, so each timestamped entry renders as its own block (the raw file differs by exactly one blank line per entry).
- `/stop` showed nothing until the whole stop pipeline finished — the master-mix ffmpeg encode is ~37 s per hour of meeting. It now **acknowledges immediately** with a message adapted to the current `/dm audio`, `/dm transcribe` and `/transcribe` settings (never promising a DM that is off), processes the recording in the **background**, and later edits that same ephemeral message to the true outcome (`Stopped. Sent the master mix to your DMs.` / nobody spoke / master write failed / delivery failed / files kept on disk). A hard processing failure now edits it to `Stopped. Something went wrong processing the recording — check the console output.` instead of leaving it on "…shortly." forever. The stop-time settings snapshot is taken once, when the acknowledgement goes out: a `/transcribe` or `/dm` change landing during the encode no longer affects that session.

## [3.0.0] - 2026-09-27

### Added
- `/dm` per-guild delivery settings (`audio`, `transcribe`), persisted in SQLite (DB `user_version` 2, migrated in place).

### Changed
- **BREAKING: `RECORDING_TYPE` removed** — every session now records the per-speaker tracks **and** the master mix; setting the variable fails startup with a loud error.
- **BREAKING: `/record_type` removed** — per-guild delivery settings are the new `/dm audio` / `/dm transcribe` (there is no recording-type setting any more).
- **BREAKING: `TRANSCRIBE_MODE` removed** — transcription always uses the per-user tracks; setting the variable fails startup with a loud error.
- **BREAKING: recordings now land in `discord-meetings/<guildId>/meeting-<stamp>/`** (the guild snowflake is the new directory level). Sessions from 2.x stay in their flat `meeting-<stamp>/` folders and are never migrated.
- **BREAKING: `/stop` DMs the master mix only** — the per-user tracks stay on disk (they feed transcription) and are never sent or zipped.
- The master mix accumulates in a temp file on disk (`master-<ts>.mix.tmp`, removed after every session) instead of in memory, so a long meeting no longer needs gigabytes of RAM (measured: 1-hour session peak heap 5.6 MB, down from ~1.38 GB).

### Removed
- `master-<ts>.md` transcripts and the speaking-log/attribution machinery (`speaking-log.jsonl`, `src/attribution.js`, `src/speaking-log.js`): transcripts always come from per-speaker audio now.

## [2.1.1] - 2026-09-22

### Added
- `build-and-push.sh` now tags the current git branch HEAD with the version it built (local tag only; the script prints the `git push origin <tag>` command to run manually). Idempotent on re-run — an existing tag is left alone, never overwritten or moved.

## [2.1.0] - 2026-09-21

### Added
- Speaker labels on MASTER transcripts: transcript lines are prefixed with the speaker's display name in the same `**Name:** [mm:ss] text` shape as combined-mode transcripts, by joining transcription segments to a per-session speaking timeline recorded while the meeting runs. The timeline is persisted as a `speaking-log.jsonl` sidecar in the meeting dir. Attribution is best-effort: simultaneous-speaker (crosstalk) overlaps that can't be resolved to one speaker render as an unlabeled line marked `⚠`; segments with no speaking-window match stay speakerless exactly as before. No env changes; no breaking changes.

## [2.0.0] - 2026-09-21

### Changed (breaking)
- **`SINGLE_FILE` removed** → `RECORDING_TYPE=PER_USER|MASTER`. Startup fails with a loud error and a rename hint if `SINGLE_FILE` is present (`SINGLE_FILE is no longer supported. Use RECORDING_TYPE=PER_USER|MASTER instead.`).
- `/singlefile` → `/record_type` (string option `PER_USER|MASTER`, ephemeral confirmation, effective from the next `/record`).

### Changed
- Docker image pins `faster-whisper` to `1.2.1` for reproducible transcription-sidecar builds (previously floating — every rebuild could pull a different version with breaking churn).
- `package.json` declares `"engines": { "node": ">=22.13" }` (`node:sqlite` is unflagged only from 22.13; npm warns on install with a mismatched Node).

### Added
- `/transcribe` command: bare use shows the current effective state; `/transcribe FALSE|TRUE` toggles transcription (mid-session changes affect the in-flight session's stop-time transcription).
- `/help` command: lists every command with a one-line description and one usage example.
- `/record` confirmation now ends with a settings tip: `Tip: /autostop, /transcribe, /record_type change settings; /help lists everything.`
- Per-guild settings persistence in SQLite via `DB_PATH` (default: `<MEETINGS_DIR>/recorder.db`; under Docker, compose points it at the `recordings` named volume so settings survive redeploys). `/record_type`, `/transcribe`, `/autostop` changes persist across restarts.
- Guild ledger auto-registration: a `guilds` row is created on invite (`GUILD_CREATE`) and on a first-ever config write; rejoin counts increment only on real rejoins (10-minute gap tolerance).
- Per-guild config isolation: each guild reads/writes its own settings row.

### Fixed
- Settings no longer reset to env defaults when the bot restarts — they are stored per guild in the SQLite database.
- Guild A's settings no longer leak into guild B on a shared bot (per-guild config isolation via keyed store lookups replaces the former process-wide closure state).

## [1.7.0] - 2026-09-20

### Added
- Speaker-attributed combined transcript for per-user sessions: each speaker's `.ogg` is transcribed and the results are merged into ONE `transcript-<TS>.md` — `**Name:**` lines interleaved on the meeting clock — DM'd to the `/record` invoker with the same `Your meeting transcript:` text as before. Mid-session joiners land at their true meeting times (per-file join stamps align every track to session start), not `[00:00]`.
- New `TRANSCRIBE_MODE=combined|master|off` env var (default `combined`): which audio gets transcribed. `master` in a per-user session is a documented no-op (no master audio exists there — the recorder is either/or by design); `off` never spawns the sidecar.
- Near-empty tracks (<~2 s of frames) are skipped before the sidecar (faster-whisper hallucinates on tiny clips); each skip is logged by file name.

### Changed
- **Default transcription output for per-user sessions changes:** existing `TRANSCRIBE=TRUE` (default) deployments that record per-user tracks now receive the combined speaker-attributed `transcript-<TS>.md` instead of no transcript (per-user sessions have no master mix, so 1.6.0 transcribed nothing there). Master-only sessions keep producing `master-<TS>.md` unchanged.
- `TRANSCRIBE` is deprecated in favor of `TRANSCRIBE_MODE`; `TRANSCRIBE=FALSE` keeps working as an alias for `off` (`true`/unset ≡ `combined`), and an explicit `TRANSCRIBE_MODE` always wins.
- One failing track no longer loses the transcript: the combined file proceeds from the remaining tracks (failure named in the log); if every track fails the run is log-only with no DM — the audio delivery is unaffected either way.

## [1.6.0] - 2026-09-20

### Added
- Post-stop master-mix transcription: after the audio is delivered (manual `/stop` or auto-stop), the bot transcribes `master-<TS>.ogg` locally with a faster-whisper Python sidecar and DMs `master-<TS>.md` (timestamped `[mm:ss]` lines) to the `/record` invoker. Fire-and-forget — a slow or failed transcription never blocks or breaks the audio path, and absence of python/faster-whisper degrades to one log line. New env vars `TRANSCRIBE` (default `TRUE`) and `WHISPER_MODEL` (default `small`, multilingual; first run downloads ~460 MB from HuggingFace).
- Docker image gains python3 + a `/opt/venv` with faster-whisper baked in (`PATH` prefers the venv interpreter), with `HF_HOME=/data/.cache` so the model download persists on the recordings volume across redeploys.

### Fixed
- Transcription can no longer hog the whole machine: the sidecar is capped at 4 CPU threads (overridable via `WHISPER_CPU_THREADS`), so a post-meeting transcript running during your next meeting no longer starves the live voice pipeline.
- Transcriptions are serialized one at a time — stopping two meetings back to back queues the second transcript instead of spawning two sidecars at once.
- Manual `/stop` now still produces the transcript when the result-DM delivery errors out: the audio path reports the failure as before, but the on-disk master is transcribed regardless.
- New `WHISPER_PYTHON` env var pins which Python interpreter spawns the sidecar — fixes "faster_whisper not installed" on Windows machines with multiple Pythons, where bare `python` resolves to the wrong one.
- `WHISPER_MODEL` is validated at startup (model name or HuggingFace repo id) instead of being passed through unchecked.

## [1.5.3] - 2026-09-19

### Added
- App version in the startup log line (`Logged in as <tag> (discord-meeting-recorder v1.5.3)`), so operators can confirm which image is live via `docker logs | grep v1.5`.

## [1.5.2] - 2026-09-19

### Fixed
- Kicked-and-reinvited guilds now re-register slash commands while the bot is running: `GUILD_CREATE` was being suppressed by the deployer's per-guild dedupe memory, but Discord deletes a guild's command registrations on kick, so the guild came back with zero commands. A `GUILD_DELETE` listener now forgets the guild (even mid-flight) so the next `GUILD_CREATE` re-registers it.

## [1.5.1] - 2026-09-19

### Fixed
- Slash commands now register automatically when the bot is added to a new server while it is running (GUILD_CREATE event, deduped per guild) — no container restart needed. The startup `GUILD_IDS` registration loop is unchanged; failed registrations are logged and re-attempted on the next event or restart.
- Success log text corrected to `Registered slash commands for guild <id>` — the old `Registered /record /stop ...` wording was stale for the full four-command set shipped since 1.5.0.

## [1.5.0] - 2026-09-19

### Added
- Combined release of both runtime configuration features on one branch: `AUTO_STOP_MINUTES` + `/autostop [minutes]` (configurable auto-stop threshold, 1–180 min, effective immediately including a live session) and `/singlefile` (runtime per_user ↔ master_only recording-mode toggle, effective from the next `/record`). Both commands register side by side; neither resets the other's state, and both remain non-persistent across restarts (each falls back to its env value — `AUTO_STOP_MINUTES` / `SINGLE_FILE`).

## [1.4.0] - 2026-09-19

### Added
- `/singlefile` slash command: bare use toggles, or `state: per_user | master_only` sets, the recording mode at runtime (ephemeral confirmation). Effective from the next `/record` — a running session keeps its mode. `SINGLE_FILE` env remains the startup default and the value the mode resets to on restart (non-persistent).

## [1.3.0] - 2026-09-19

### Added
- `AUTO_STOP_MINUTES` env var (integer minutes 1-180, default 5) sets the auto-stop threshold at startup.
- `/autostop [minutes]` slash command shows (bare) or sets the threshold at runtime, effective immediately for live sessions; non-persistent — resets to `AUTO_STOP_MINUTES` on restart.

## [1.2.0] - 2026-09-19

### Added
- Lifecycle announcements in the voice channel's text chat: `/record` start, `/stop` completion, and auto-stop (with the trigger reason verbatim — `no voice activity for N min` / `everyone left the voice channel`) each post a message mentioning the invoker, plus whether files were delivered or nobody spoke. Audio still arrives via DM only.

### Changed
- Command replies are ephemeral confirmations for the typist (`Recording in …`, `Stopped. …`); the voice channel text chat is the single public venue for lifecycle tracking. Guard feedback (`Already recording.`, `Join a voice channel first.`, `Nothing recording.`) is ephemeral and announces nothing publicly.

## [1.1.0] - 2026-09-19

### Added
- Auto-stop failsafe: sessions ≥ 5 min that go 5 min without voice activity (comfort-noise/muted packets do not count) or whose voice channel empties are stopped and delivered exactly like `/stop`, with the result DM'd to the `/record` invoker; trigger reason logged to the console.

## [1.0.0] - 2026-09-18

First release. `/record` + `/stop` per-user or master-mix Discord voice recording, delivered as .ogg/zip via DM. Docker-ready.

### Added
- Docker deployment: multi-stage `Dockerfile` (Node 22 slim, ffmpeg included, non-root `node` user), `docker-compose.yml` with named `recordings` volume mounted at `/data`, and `.dockerignore`
- Optional master mix via `SINGLE_FILE=TRUE|FALSE` (default `FALSE`): one `master-$TIMESTAMP.ogg` for the session
- Timestamped console event logging for session join/stop and speaking activity
- Debounced speaking gate with Opus packet-size activity floor (ignore mic glitches)
- Per-segment filenames `$USER-$TIMESTAMP.ogg` when not in master-only mode
- `src/wav.js` helper for writing PCM WAV intermediates

### Changed
- **Master mix size/quality tuning:** encode **mono** (`-ac 1`) with **`-application voip`** and bitrate cap **`MASTER_BITRATE` env (default `24k`)** instead of 128k stereo `audio` mode — measured 3.6× smaller (247 KB vs 889 KB per 60 s of tone); 2 h of a typical meeting (speech + silence) fits Discord's 25 MB upload
- **`GUILD_ID` → `GUILD_IDS`:** comma-separated list of guild snowflakes; slash commands register in **each** guild, and one failing guild logs an error without blocking the others
- **Master mix audio quality:** place packets on a **20 ms grid**, float sum + soft limit, encode via **WAV → ffmpeg `libopus`** (no second `opusscript` Opus pass). Falls back to `.wav` if ffmpeg fails
- `/record` / `/stop` slash descriptions are intentionally vague (no “per speaker” wording)
- `SINGLE_FILE=TRUE` records **master only** (no per-user `.ogg` files); speaking start/stop logs still run
- Unconfirmed glitch segments are discarded in per-user mode
