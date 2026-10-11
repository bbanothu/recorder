# Setup

## Requirements

- **Node.js ≥ 22.13** (developed on **26.7.0**) — hard requirement: 2.0.0 uses `node:sqlite`, unflagged only from v22.13.0 (22.5–22.12 have it only behind `--experimental-sqlite`; the bot exits loudly at startup if too old). Docker: the image pins Node 22 for you.
- **ffmpeg / ffprobe** on `PATH` — **required for every session**: the master mix is always built (`ffmpeg -c:a libopus`, **mono, voip mode, bitrate capped by `MASTER_BITRATE` (default 24k)**). Without ffmpeg the bot keeps a `.wav` fallback — stereo 48 kHz, over Discord's 25 MB cap after ~2 minutes — so it stays on disk and is never DM'd. Since 3.0.2 ffmpeg is also used by the transcription path (each track is transcoded to a temporary 16 kHz mono WAV before the sidecar). Also useful for verifying `.ogg` files with `ffprobe`.
- **Python 3 + faster-whisper** — only for post-stop transcription. The Docker image bakes in python3, a venv, and faster-whisper 1.2.1 (nothing to do). Bare `npm start`: `python -m pip install faster-whisper "av<15"`; if absent the bot logs one line and skips transcription gracefully. The `av<15` pin matters: faster-whisper 1.2.1 calls `av.open(..., metadata_errors=...)`, a keyword PyAV 15+ removed, so a bare `pip install faster-whisper` grabs the newest `av` and every transcription fails with `TypeError: open() got an unexpected keyword argument 'metadata_errors'`. The Whisper model (`small` by default) auto-downloads from HuggingFace on first run into `HF_HOME` (under Docker: `/data/.cache` on the recordings volume, so it persists). CUDA is auto-detected when a GPU is present; otherwise int8 on CPU.
- Discord bot with voice permissions in your guild

## Discord Developer Portal

1. Create an application → Bot → copy token → `DISCORD_BOT_TOKEN`.
2. Enable **Server Members Intent** if you want reliable display names from cache (recommended). **Message Content Intent** is **not** required (slash commands only).
3. OAuth2 URL Generator: scopes `bot` + `applications.commands`.  
   Bot permissions: **Connect**, **Speak**, **View Channel**, **Use Voice Activity** (and Send Messages if you want channel replies).
4. Invite the bot to your guild(s). Copy each guild snowflake → `GUILD_IDS` (comma-separated). Commands also register automatically when the bot is invited to a new server — including after a kick and re-invite — no restart needed; `GUILD_IDS` remains the startup registration list for already-joined guilds.
5. **DAVE**: Discord enforces voice end-to-end encryption. This project uses `@discordjs/voice` + `@snazzah/davey` (auto-wired; `daveEncryption` defaults to on). Join with `selfDeaf: false` so the bot can receive audio.

## Environment

| Variable | Meaning |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Bot token |
| `MEETINGS_DIR` | **Absolute** directory under which `discord-meetings/` is created |
| `GUILD_IDS` | Comma-separated guild snowflakes for instant slash-command registration (e.g. `123,456`) |
| `DB_PATH` | SQLite database file for per-guild settings + guild ledger. Default when unset: `<MEETINGS_DIR>/recorder.db`. Under Docker, compose sets `DB_PATH=/data/recorder.db` (the recordings named volume) so settings persist across redeploys; see the [two storage options](#database-storage) |
| `MASTER_BITRATE` | Opus bitrate cap for the master mix (default `24k`). Mono + voip mode; ≈ 10.8 MB/h continuous-audio worst case (Opus VBR can overshoot the nominal bitrate slightly) → ~2.4 h fits Discord's 25 MB upload (real meetings are well under that since silence compresses away) |
| `AUTO_STOP_MINUTES` | Auto-stop failsafe threshold in whole minutes, 1–180 (default `5`). `/autostop minutes:N` overrides it at runtime — **per guild, persisted across restarts**; the env value is the seed default only |
| `TRANSCRIBE` | Produce-gate for transcription (`TRUE`, default / `FALSE`) — the runtime toggle, changeable per guild with `/transcribe` (persisted). Transcription always runs on the **per-user tracks** and produces one speaker-attributed `transcript-<TS>.md` per session (there is no mode any more); whether that file is DM'd is the separate per-guild `/dm transcribe` setting, with no env var. Graceful skip (one log line) when python/faster-whisper are absent |
| `WHISPER_MODEL` | Whisper model for the sidecar: `tiny`/`base`/`small` (default)/`medium`/`large-v3`. Multilingual; first run downloads the model into `HF_HOME` |
| `WHISPER_PYTHON` | Optional absolute path to the python interpreter that has faster-whisper (bare-metal multi-Python hosts only) |
| `WHISPER_CPU_THREADS` | CPU threads the sidecar may use (default `4`) |

Example (Windows):

```
DISCORD_BOT_TOKEN=...
MEETINGS_DIR=C:\Users\you\Documents\GitHub\discord-meeting-recorder
GUILD_IDS=138464241140236288,1473835448932634708
```

### Upgrading from 2.x (3.0.0 breaking changes)

- **`RECORDING_TYPE` and `TRANSCRIBE_MODE` are removed** (the DB columns `record_type` / `transcribe_mode` go with them). If either is still set in `.env`, startup fails loudly and names the variable — delete the line. Every session now records the per-speaker tracks **and** the master mix, and transcription always runs on the per-user tracks.
- **`/record_type` is gone** — per-guild delivery settings moved to `/dm audio` / `/dm transcribe`.
- **Recordings now land in `discord-meetings/<guildId>/meeting-<stamp>/`.** Sessions recorded by 2.x stay in their flat `meeting-<stamp>/` folders; nothing migrates them.
- **`/stop` DMs the master mix only.** The per-user tracks stay on disk as the transcription input — they are never zipped and never sent.

**Downgrade note:** 3.0.0 migrates the settings DB in place — it drops `record_type`/`transcribe_mode` and sets `user_version = 2`. A 2.x binary cannot open that database (its store prepares those columns at startup and exits), so downgrading to 2.x means deleting or recreating the DB file, which loses every per-guild setting (`/dm`, `/transcribe`, `/autostop`).

## Commands

All replies are ephemeral. `/record` and `/autostop` are unchanged in UX; 2.0.0 added `/transcribe` and `/help`, 3.0.0 added `/dm`, and 3.0.1 changed `/stop` (see the note under the table):

| Command | Effect |
|---------|--------|
| `/dm [audio] [transcribe]` | Show or set per-guild delivery: `audio` (DM the master mix on `/stop`), `transcribe` (DM the transcript file). Omit to view; setting one leaves the other alone |
| `/transcribe [enabled]` | Show or set the `TRANSCRIBE` toggle `TRUE` \| `FALSE` |
| `/help` | List every command, one-line description + one usage example each |

`/dm`, `/transcribe`, `/autostop` are **per guild and persisted in SQLite** — they survive restarts and never leak across guilds.

**`/stop` (3.0.1):** it acknowledges **immediately** with a message adapted to the current `/dm audio`, `/dm transcribe` and `/transcribe` settings, then encodes and delivers in the background; that same ephemeral message is later edited to the outcome (sent / nobody spoke / kept on disk / delivery failed), or — on a hard processing failure — to `Stopped. Something went wrong processing the recording — check the console output.` The stop-time settings snapshot is taken once, when the acknowledgement goes out, so a `/transcribe` or `/dm` change made during the encode applies to the next session, not the one stopping.

## Install & run

```bash
npm install
npm start
```

You should see `Logged in as …` and `Registered /record /stop for guild …` (`node` must be ≥ 22.13 for `node:sqlite`).

### Invite notetaker (preview, runs locally)

A separate process that watches a mailbox for Google Meet / Zoom invites, joins each **Google Meet** at its start time, records the call and writes a transcript. Zoom invites are scheduled but not joined yet. Design: `.project/specs/notetaker-invite-bot.md`.

Joining needs, on the machine that runs it: Google Chrome or Chromium, PulseAudio or PipeWire (`pactl`), ffmpeg, and a desktop session (or `NOTETAKER_HEADLESS=true`). Transcription needs a Python with `faster-whisper` (set `WHISPER_PYTHON`); without it the transcript is built from Meet's live captions.

1. In Zoho Mail, enable IMAP access and create an **app-specific password** for the mailbox (do not use the account password).
2. Add to `.env` (only `MEETINGS_DIR` is shared with the Discord bot; the Discord variables are not needed):

| Variable | Meaning |
|----------|---------|
| `NOTETAKER_EMAIL` | Mailbox that receives the invites, e.g. `support@spotslocal.com` (required) |
| `NOTETAKER_APP_PASSWORD` | Zoho app-specific password (required) |
| `NOTETAKER_ALLOWED_ORGANIZERS` | Consent guard (required): comma-separated emails and/or exact `@domain` entries. Invites from any other organizer are logged and ignored |
| `NOTETAKER_BOT_NAME` | Name shown to participants (default `SpotsLocal Recorder`) |
| `NOTETAKER_IMAP_HOST` / `NOTETAKER_IMAP_PORT` | Default `imap.zoho.com` / `993` |
| `NOTETAKER_DB_PATH` | Schedule database (default `<MEETINGS_DIR>/notetaker.db`, separate from `DB_PATH`) |
| `NOTETAKER_POLL_SECONDS` | Mailbox poll interval, 15–3600 (default `60`) |
| `NOTETAKER_LOOKBACK_DAYS` | How far back a poll looks for invites, 1–90 (default `14`) |
| `NOTETAKER_ADMIT_TIMEOUT_MIN` | Minutes to wait in the Meet lobby, 1–60 (default `10`) |
| `NOTETAKER_BROWSER_PROFILE` | Chrome profile the bot joins with (default `<MEETINGS_DIR>/notetaker-browser`) |
| `NOTETAKER_CHROME_PATH` | Chrome/Chromium binary (default: first found in `/usr/bin`) |
| `NOTETAKER_HEADLESS` | `true` runs Chrome without a window (default `false`) |
| `WHISPER_MODEL` / `WHISPER_PYTHON` | Same as the Discord bot's; used to transcribe the meeting |

3. Once: `npm run notetaker:login` opens Chrome with the bot's profile. Sign in as the invited address, then close the window. Meetings run by personal Google accounts usually refuse signed-out guests.
4. `npm run notetaker`. You should see `notetaker v… watching …`, then one `invite added: …` line per allowed invite. A minute before the start the bot opens Chrome, joins (someone may have to admit it), posts "This meeting is being recorded and transcribed." in the chat and turns on captions. It leaves when it has been alone for 2 min, 30 min after the scheduled end, or after 4 h. Output goes to `<MEETINGS_DIR>/notetaker-meetings/meeting-<stamp>/`: `mix-<stamp>.ogg`, `captions-<stamp>.jsonl`, `whisper-<stamp>.json` and `transcript-<stamp>.md`, with speaker names taken from the captions. `npm run notetaker:relabel -- <meeting dir>` rebuilds the transcript from the saved files without transcribing again.

To test joining without an invite: `npm run notetaker:join -- https://meet.google.com/abc-defg-hij [minutes]`.

The inbox is opened **read-only**: nothing is marked read, moved or deleted, so people can keep using the mailbox normally. Processed messages are tracked in the notetaker database instead. Updated invites (a higher `SEQUENCE`) reschedule, cancellations cancel, and weekly or other recurring series roll over to the next occurrence, skipping `EXDATE`s.

### Phone recorder server (in progress)

Receives audio from the phone app (`mobile/`) and keeps a rolling transcript per phone. Design: `.project/specs/phone-recorder.md`.

1. Set `PHONE_TOKEN` (24+ random characters, e.g. `openssl rand -hex 24`) and `PHONE_BIND` (your Tailscale address from `tailscale ip -4`) in `.env`. `WHISPER_PYTHON` / `WHISPER_MODEL` are shared with the bot.
2. `npm run phone-server`. You should see `phone-server v… listening on http://100.x.x.x:8787`.

The phone uploads 1-minute chunks to `PUT /v1/devices/<id>/chunks/<startedAtMs>?durationMs=…`; each is transcribed in order. `POST /v1/devices/<id>/clips {fromMs, toMs}` keeps that range: a `transcript-….md` plus the audio under `<MEETINGS_DIR>/phone/<id>/clips/<n>/`. Anything else older than the device's window (`PUT /v1/devices/<id> {windowMinutes}`, default `PHONE_DEFAULT_WINDOW_MINUTES`) is deleted, audio and transcript alike. Every request except `GET /v1/health` needs `Authorization: Bearer <PHONE_TOKEN>`.

| Variable | Meaning |
|----------|---------|
| `PHONE_TOKEN` | Bearer token the app sends (required, 24+ characters) |
| `PHONE_BIND` / `PHONE_PORT` | Listen address and port (default `127.0.0.1` / `8787`) |
| `PHONE_DB_PATH` | Database (default `<MEETINGS_DIR>/phone.db`) |
| `PHONE_DEFAULT_WINDOW_MINUTES` | Window for a new phone, 1–1440 (default `60`) |
| `PHONE_MAX_CHUNK_MB` | Largest chunk upload, 1–500 MB (default `50`) |

#### Phone app (`mobile/`, Expo SDK 57)

Records while the app is open (background recording is the next phase), in 1-minute AAC files. Uploads hourly and before every clip; **Clip** saves the last 5 / 15 / 30 minutes or everything still kept, then shows the transcript, which you can share as `.md`.

1. Install **Tailscale** and **Expo Go** on the phone; sign Tailscale in to the same tailnet as this machine.
2. `cd mobile && npm install`, then `REACT_NATIVE_PACKAGER_HOSTNAME=$(tailscale ip -4) npx expo start` and scan the QR code with Expo Go (iOS: the Camera app).
3. In the app's **Settings**: Server URL `http://<tailscale ip>:8787`, Token = `PHONE_TOKEN`. **Test connection**, then **Save**.
4. **Start listening**. Keep the screen open for now.

Standalone builds (needed for background recording) go through EAS Build: this machine (Linux aarch64) cannot run Hermes' bytecode compiler or build iOS. For plain `http://` in a standalone Android build, either serve the API over HTTPS with `tailscale serve`, or allow cleartext traffic.

### Docker

```bash
docker compose up -d      # builds the image on first run, then starts
docker compose logs -f    # expect: Logged in as … / Registered /record /stop
docker compose down
```

- `MEETINGS_DIR` is overridden to `/data` inside the container and backed by the
  named `recordings` volume — set it in `.env` only for bare-metal runs.
- `DB_PATH=/data/recorder.db` is set by compose: the settings DB lives in the
  same volume and persists across redeploys. See the storage options below.
- ffmpeg ships in the image, so the master mix — built for **every** session —
  always encodes to Opus (no `.wav` fallback needed).
- The image bakes in python3 + a `/opt/venv` with faster-whisper 1.2.1, so
  transcription works out of the box; `HF_HOME=/data/.cache` keeps the model
  download (~460 MB for `small`) on the recordings volume across redeploys.
- No ports to expose: all traffic (WSS + voice UDP) is outbound.

### Database storage

Two supported options (configured in `docker-compose.yml`):

1. **Default — recordings named volume (recommended):** compose sets
   `DB_PATH=/data/recorder.db`, so the DB lives inside the `recordings` volume
   and the per-guild settings survive redeploys alongside the recordings.
2. **Alternative — host disk:** comment out `DB_PATH: /data/recorder.db`, point
   it at `DB_PATH: /db/recorder.db`, and uncomment the `- ./:/db` volume in
   `docker-compose.yml` (the commented alternative is right there). Easy to
   back up / inspect with any sqlite3 client. Rules:
   - Bind a host **directory**, never a single file — WAL journaling creates
     `-wal`/`-shm` sidecars next to the DB file.
   - On Linux hosts, `chown` the host directory to UID 1000 (the container runs
     as user `node`) or the app cannot write.
   - Moving `DB_PATH` after first run leaves the old DB (answers/records +
     per-guild settings) behind — copy the file over first.

On bare metal, the default location is simply `<MEETINGS_DIR>/recorder.db`
(override with `DB_PATH` in `.env`).

### Native module note (`@snazzah/davey`)

davey ships prebuilds. If install/runtime fails on a bleeding-edge Node, use Node ≥ 22.13 and reinstall:

```bash
nvm install 22
nvm use 22
rm -rf node_modules
npm install
```

## Stack pins (from Task 1 spike)

See `C:\Users\wot38\spike-voice\FINDINGS.md` for the verified receive + Ogg mux path. Production deps are pinned in `package.json` / lockfile accordingly.
