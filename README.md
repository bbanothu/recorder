# Discord Meeting Recorder

Slash commands `/record` and `/stop` join the caller's voice channel, capture audio, then DM the **master mix** to the invoker; every session records the per-speaker tracks **and** the master mix, `/dm` sets per-guild delivery (`audio`, `transcribe`), `/transcribe` toggles transcription, and `/help` lists every command. Commands also register automatically when the bot is invited to a new server — including after a kick and re-invite — no restart needed; `GUILD_IDS` remains the startup registration list for already-joined guilds.

## Consent warning (read first)

**Recording other people without clear consent may be illegal.**  
This bot captures voice audio whenever someone speaks in a channel it has joined.

- **Texas** is generally a **one-party** consent state for call recording.
- **Illinois** and **Missouri** are generally **two-party / all-party** consent states.

You are responsible for notifying participants and complying with the law where you and they are located. Prefer an explicit server rule or verbal notice before `/record`. Participants see start/stop/auto-stop announcements in the voice channel's text chat; recorded audio itself is still delivered privately to the `/record` invoker's DMs.

## Setup

See [SETUP.md](./SETUP.md) for Discord portal (DAVE), env vars, Node notes, and DB storage options.

```bash
cp .env.example .env
# DISCORD_BOT_TOKEN, MEETINGS_DIR (absolute path), GUILD_IDS
npm install
npm start
```

### Or with Docker

```bash
cp .env.example .env   # fill in DISCORD_BOT_TOKEN, GUILD_IDS (MEETINGS_DIR is ignored — see below)
docker compose up -d
docker compose logs -f
```

The image requires Node ≥ 22.13 (unflagged `node:sqlite`; that's pinned in the Dockerfile) and runs ffmpeg (mono voip Opus encode) + a python3 venv with faster-whisper 1.2.1 baked in, as a non-root user. Recordings land in the named volume at `recordings/discord-meetings/<guildId>/meeting-<timestamp>/...` (compose overrides `MEETINGS_DIR=/data`), and per-guild settings persist in SQLite at `/data/recorder.db` — also on that volume, so they survive redeploys. Inspect files with `docker compose exec recorder ls -R /data`, or copy a meeting out with `docker cp discord-meeting-recorder:/data/discord-meetings/<guildId>/<meeting-dir> .`.

## Commands

| Command | Effect |
|---------|--------|
| `/record` | Start a voice recording session in your current channel (the confirmation reply ends with a settings tip: `/autostop`, `/transcribe`, `/dm`; `/help` lists everything) |
| `/stop` | Stop the session. Replies **immediately** with an acknowledgement adapted to the current `/dm audio`, `/dm transcribe` and `/transcribe` settings (so it never promises a DM that is off), then encodes and delivers in the background. That same ephemeral message is later edited to the true outcome (sent / nobody spoke / kept on disk / delivery failed). |
| `/dm [audio] [transcribe]` | Show or set per-guild delivery: `audio` (DM the master mix on `/stop`) and `transcribe` (DM the transcript file). Omit both to view; setting one leaves the other alone. Both default `TRUE`. **Stored per guild; persists across restarts.** |
| `/transcribe [enabled]` | Show or set whether sessions are transcribed (`TRUE`/`FALSE`). Omit the argument to view. Applies at stop time: the gates use the snapshot taken when `/stop` acknowledges, so a change made before `/stop` still affects that session, while one landing during the encode only affects later sessions. **Stored per guild; persists across restarts.** |
| `/autostop [minutes]` | Show or set the auto-stop threshold (1–180 min). Applies immediately, including a live session (the timer re-reads it every tick). **Stored per guild; persists across restarts.** |
| `/help` | List every command with a one-line description and one usage example |

### Settings persistence

`/dm`, `/transcribe`, and `/autostop` are stored per guild in a SQLite database (via `node:sqlite`) and survive restarts — they never reset to the env values after a downtime. The env vars (`TRANSCRIBE`, `AUTO_STOP_MINUTES`) only seed the defaults for a guild that hasn't set its own value yet; the moment a guild's first slash-command write creates its row, that row wins permanently for that guild. Delivery (`/dm`) is runtime-only — it has **no** env var at all. Settings are keyed by `guild_id`, so two guilds using the same bot never affect each other. On bare metal the DB lives at `<MEETINGS_DIR>/recorder.db` (override with `DB_PATH`); under Docker it's on the recordings volume — see the two storage options below.

## Always both (`RECORDING_TYPE` is gone)

Every session records **both** the per-speaker `$USER-$TIMESTAMP.ogg` tracks and one mixed `master-$TIMESTAMP.ogg` (20 ms grid → WAV → ffmpeg Opus, **mono voip @ `MASTER_BITRATE` (default 24k)**). There is no setting for it: the `RECORDING_TYPE` env var and the `/record_type` command were removed in 3.0.0 (setting the env var now fails startup loudly), and `/dm` replaces the command for delivery settings.

### Delivery: the master mix only

`/stop` DMs the **master mix** as a single `.ogg` (text `Your meeting recording (master mix):`). The per-speaker tracks are **never DM'd and never zipped** — they stay on disk as the transcription input, and the reply names their directory. A master that came back as `.wav` (ffmpeg missing) is never sent either: it is stereo 48 kHz and would blow Discord's 25 MB cap in about two minutes, so it stays on disk and the reply says so. When the master is over the cap, or the DM is refused, the reply carries the on-disk path instead. `/dm audio FALSE` sends nothing and keeps the files — a suppressed delivery, not a failed one.

`/stop` no longer makes you wait: it replies **immediately** with an acknowledgement chosen from the current `/dm audio`, `/dm transcribe` and `/transcribe` settings, then runs the teardown, master-mix encode and delivery in the **background** — the DM arrives when the encode finishes (see the ~37 s/hour figure under Known limits). The acknowledgement is the ephemeral reply itself, and it is later **edited in place to the outcome**: `Stopped. Sent the master mix to your DMs.`, nobody spoke, a failed master write, a suppressed delivery (`/dm audio FALSE`), or a delivery failure. If processing fails hard before it can report anything, that message becomes `Stopped. Something went wrong processing the recording — check the console output.` — the voice-channel notice carries the same truth. The settings snapshot is taken once, when the acknowledgement goes out, so a `/dm` or `/transcribe` change landing during the encode applies to the next session, not the one stopping.

## Transcription

After each stop (manual `/stop` or auto-stop), the bot transcribes locally with a faster-whisper sidecar and DMs the transcript file (with text `Your meeting transcript:`) to the `/record` invoker — unless `/dm transcribe FALSE`. The transcript is written beside the recording and arrives minutes later — fire-and-forget, so it never blocks the `/stop` acknowledgement and a slow or failed transcription never breaks delivery.

Transcription always runs on the **per-user tracks** (isolated per-speaker audio, no mix bleed): each speaker's `.ogg` is transcribed and the results are merged into **one** speaker-attributed `transcript-<TS>.md` — `**Alice:** …` / `**Bob:** …` lines interleaved on the meeting clock, so a mid-session joiner's lines land at their true meeting times, not `[00:00]`. Entries are separated by a **blank line**, so each timestamp starts its own line even when the `.md` is previewed as markdown (Discord previews the file, and a single newline is a soft break that used to collapse every entry onto one line). Same-name users and rejoin segments share a label by design (the separate audio tracks still distinguish them). 3.0.0 removed the master-transcript route along with `TRANSCRIBE_MODE`: there is no `master-<TS>.md` and no `speaking-log.jsonl` sidecar any more (setting `TRANSCRIBE_MODE` now fails startup loudly). Degradation: tracks under ~2 s never reach the sidecar (skip logged); one failing track still yields the combined transcript from the rest (named log line); if every track fails it's log-only, no DM — the audio was delivered fine either way. Wall time: with N speakers the transcript arrives only after the **last** track is transcribed (N sequential sidecar runs; per-track VAD prunes silence, so usually far less than N× realtime) — `WHISPER_MODEL=base` is the speed dial. Gate: transcription is **off when `TRANSCRIBE=false`** — `TRANSCRIBE` is the produce-gate, runtime-toggleable with `/transcribe`, while whether the produced file is DM'd is the separate per-guild `/dm transcribe` setting. Model: `WHISPER_MODEL` (default `small`, multilingual — ~460 MB downloaded from HuggingFace on first run into the `HF_HOME` cache, which lives on the recordings volume under Docker so it persists). No python/faster-whisper present → one log line, graceful skip. See SETUP.md for install notes.

Since 3.0.2: a speaker whose track yields no recognized speech is named in the transcript (`_No speech recognized for **name** (file)._`) rather than silently absent, and a name that spans several tracks after a rejoin gets one note. Each track is first canonicalised through ffmpeg (16 kHz mono WAV) so an undecodable packet can never truncate a transcript; the stop-time log reads `(N segments, M tracks, K with speech)`. Every session also writes `timeline-<TS>.jsonl` (session start, tracks, speech bursts, leave/reconnect) beside the recordings as a diagnostic record.

Resource safety: transcription runs **after** delivery, **serialized** (one sidecar at a time — back-to-back stops queue instead of double-spawning python), and **CPU-capped** (default 4 threads via `WHISPER_CPU_THREADS`; lower it on a small VPS so a long transcript can never starve a live recording). Set `/transcribe FALSE` to revert to pure audio-only behavior.

## Example file tree

```
MEETINGS_DIR/
  discord-meetings/
    <guildId>/
      meeting-2026-09-18-21-04-33/
        Alice-20260918-210450-012.ogg
        Bob-20260918-210451-300.ogg
        master-20260918-210450-000.ogg
        timeline-20260918-210450-000.jsonl
        transcript-2026-09-18_21-04.md
```

Since 3.0.0 a session directory is `<guildId>/meeting-<stamp>/` — the guild snowflake is the new level, so two guilds' sessions are distinguishable. Sessions recorded before 3.0.0 sit in a **flat** `meeting-<stamp>/` directory beside the guild folders: they stay where they are and are never migrated (an old session's guild cannot be recovered retroactively).

While a session runs, the master mix accumulates in `master-<ts>.mix.tmp` in the same directory. That file is a **build artifact**, not audio: `finalize()` removes it after every session, success or failure, and it is always safe to delete. A leftover means the process was killed mid-session; the finished audio is the `.ogg` (or the `.wav` when ffmpeg is missing), never the `.tmp`.

Per-user segments use UTC `YYYYMMDD-HHMMSS-mmm` so leave/rejoin never overwrites.

## Database (settings persistence)

Per-guild settings and the guild ledger live in one SQLite database (`node:sqlite`, WAL journaling), located by `DB_PATH`:

- **Default (no `DB_PATH` set):** `<MEETINGS_DIR>/recorder.db` — a plain disk file next to the recordings.
- **Under Docker:** compose sets `DB_PATH=/data/recorder.db` — inside the `recordings` named volume, so the settings persist across redeploys alongside the recordings.
- **Alternative (host disk):** comment out the compose `DB_PATH` and uncomment the `- ./:/db` bind mount in [docker-compose.yml](./docker-compose.yml), then set `DB_PATH: /db/recorder.db`. Bind a host **directory** — never a single file: WAL journaling creates `-wal`/`-shm` sidecars next to the DB file. On Linux hosts, `chown` the host directory to UID 1000 so the container's `node` user can write. Moving `DB_PATH` after first run leaves the old DB (and its per-guild settings) behind — copy the file over first.

## Known limits

- Discord does not send silence (gaps between talk spurts are omitted from the wire). Both the master mix and, since 3.0.2, each per-user track fill those gaps on a 20 ms grid, so track time is meeting time. Silence in a per-user track costs 31 B per 20 ms (3-byte libopus silence frame, one Ogg page each) ≈ 5.3 MB per speaker-hour; transcription's ffmpeg canonicalisation adds a temporary 16 kHz mono WAV (~115 MB per track-hour, a few hundred ms per few minutes of audio).
- A crash mid-session loses in-flight (not-yet-finalized) audio.
- No automatic disk cleanup.
- Single session at a time (second `/record` is rejected until `/stop`).
- Master mix is a receive-time grid sum, not a studio DAW mix; further gains need PLC / better timing.
- Master Opus output needs **ffmpeg** on `PATH` for **every** session — the mix is always built; without ffmpeg you get a `.wav` instead of `.ogg`, and that `.wav` is never DM'd.
- Keep `MEETINGS_DIR` on **local disk**: the master-mix accumulator does a synchronous read+write per audio packet inside the voice packet callback, so a network share or an AV-scanned folder can stall audio receive for everyone.
- `/stop` spends ~37 s encoding the master mix for a 1-hour meeting (measured). The acknowledgement is immediate, but the DM arrives only when the encode finishes, so a stop is not instant on long sessions.
- Auto-stop after N min of no voice activity or an emptied channel (≥ N min in; N = `AUTO_STOP_MINUTES`, default 5, runtime-settable via `/autostop`); comfort noise from muted-but-present users does not count as activity.

## Tests

```bash
npm test
```

## Invite notetaker (preview)

`npm run notetaker` starts a separate process: invite the notetaker's mailbox to a Google Meet or Zoom meeting and the meeting is scheduled. Only organizers on `NOTETAKER_ALLOWED_ORGANIZERS` are accepted. **Joining and recording are not built yet:** at start time the meeting is only logged as `would join`. Setup is in [SETUP.md](./SETUP.md#invite-notetaker-preview-runs-locally) and the design in `.project/specs/notetaker-invite-bot.md`. The consent warning above applies to it in full.

## Future: notes

Out of scope for this bot. Word-level timestamps and diarization of a shared mic are possible later additions reusing the same sidecar (per-user tracks already carry speaker labels; see Transcription).
