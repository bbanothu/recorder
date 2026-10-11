# Design: invite-an-email notetaker (Google Meet + Zoom)

Status: **Draft**. Items marked *working default* were not decided by the user yet;
each is a one-line change before a plan is written.

Branch: `google` (cut from `master` at `27ecc0a`, v3.0.2).

## Goal

Add `support@spotslocal.com` to a meeting invite and the bot joins that Google Meet
or Zoom call at the start time, records it **automatically** (no per-meeting
confirmation), and delivers a speaker-attributed transcript in the same
`transcript-<TS>.md` shape the Discord bot produces.

## Facts that shape the design (verified 2026-10-04)

- **`spotslocal.com` mail is Zoho, not Google Workspace** (MX = `mx.zoho.com`,
  `mx2.zoho.com`, `mx3.zoho.com`). Invites arrive as emails carrying an `.ics`, so
  there is no Google Calendar to poll. Intake is **IMAP on Zoho**.
- **Google Meet has no supported bot-join API.** The Meet Media API is a developer
  preview that requires *every participant* to be enrolled and only sends the 3 most
  relevant speakers' audio. A Meet bot is therefore a **scripted browser** that joins
  as a guest. It hears the **mixed** call audio only.
- **Zoom** can be joined the same way (web client) or through the Meeting SDK, which
  gives per-participant raw audio but needs a Zoom Marketplace app and host recording
  permission.

## Architecture

New, separate process in this repo: `npm run notetaker` → `src/notetaker/index.js`,
with its own Docker service. The Discord bot is untouched. A crash in a browser
session must never affect the Discord recorder (AGENTS.md: a dead process loses live
recordings), which is why this is a separate process.

```
Zoho IMAP ──► invite parser ──► schedule (SQLite) ──► scheduler
                                                          │ at DTSTART − 1 min
                                                          ▼
                                    joiner (Playwright Chromium, Xvfb, PulseAudio sink)
                                     ├─ ffmpeg records the sink → mixed audio file
                                     └─ DOM watcher → speaker timeline (who spoke when)
                                                          │ on leave
                                                          ▼
         faster-whisper (existing sidecar) ──► speaker attribution ──► transcript .md
                                                          │
                                                          ▼
                                              email reply (Zoho SMTP)
```

### D1 — Intake: IMAP poll of the Zoho mailbox

- Library: `imapflow`, `imap.zoho.com:993`. Polls every 60 s (DI `setInterval`).
- Auth: a **Zoho app-specific password** in `.env`. Never the account password, never
  committed. Zoho requires IMAP access to be enabled in mail settings.
- Parse `text/calendar` parts with `node-ical`: `UID`, `SEQUENCE`, `METHOD`,
  `DTSTART`/`DTEND` (with TZID), `ORGANIZER`, and the join URL found in `URL`,
  `LOCATION`, `DESCRIPTION` or `X-GOOGLE-CONFERENCE`.
- Link detection: `https://meet.google.com/<abc-defg-hij>` and
  `https://*.zoom.us/j/<id>[?pwd=…]`. Pure module `src/notetaker/invite.js`, unit-tested
  against fixture `.ics` files from Google Calendar, Outlook, Zoom and Zoho.
- `METHOD:CANCEL` → cancel the job. A higher `SEQUENCE` for the same `UID` → reschedule.
  Recurring events (`RRULE`): *working default*: expand only the next occurrence on each
  poll.

### D2 — Schedule store

- A new `meetings` table in a notetaker-owned SQLite file (`NOTETAKER_DB_PATH`), never
  the Discord bot's `recorder.db`. Columns: `uid`, `sequence`, `platform`, `join_url`,
  `organizer`, `starts_at`, `ends_at`, `state` (`scheduled|joining|recording|done|failed|cancelled`).
- Survives restarts. On startup, a job whose start time has passed but whose end time
  has not is still joined.

### D3 — Who may trigger a recording (consent guard)

- `support@` is a customer-facing address: a customer inviting support to a call would
  otherwise be recorded automatically. **Working default:** `NOTETAKER_ALLOWED_ORGANIZERS`
  (comma-separated emails or `@domain` entries) is **required**. An invite from anyone
  else is logged and ignored.
- The bot joins under a visible name (`NOTETAKER_BOT_NAME`, default
  `SpotsLocal Recorder`) and posts a chat message on join: "This meeting is being
  recorded and transcribed." Same intent as the Discord channel notices.

### D4 — Joiner: one browser per meeting

- Playwright Chromium under Xvfb, its output routed to a PulseAudio null sink. ffmpeg
  records `sink.monitor` to `meeting-<stamp>/mix-<stamp>.ogg` (mono voip, matching the
  master settings in AGENTS.md).
- **Meet:** join as a guest by name (no Google sign-in), wait in the lobby until admitted
  (timeout `NOTETAKER_ADMIT_TIMEOUT_MIN`, default 10). Mic and camera off.
- **Zoom:** web client `app.zoom.us/wc/join/<id>`. Same pattern. The Meeting SDK route
  (per-speaker audio) is a later upgrade, not this release.
- Leave when the bot is the only participant for 2 min, at `DTEND + 30 min`, or at a hard
  cap of 4 h. The decision is a pure function in the same style as `src/auto-stop.js`.
- Selectors live in one file per platform (`src/notetaker/platforms/meet.js`,
  `zoom.js`). They are the expected breakage point when Google or Zoom change their UI.

### D5 — Speaker timeline and attribution

- A DOM watcher records active-speaker changes `{t, name}` into
  `timeline-<stamp>.jsonl`, reusing the format in `src/timeline.js`.
- New pure module `src/speaker-attribution.js`: give each whisper segment the speaker
  with the greatest time overlap, or `null` if no speaker overlaps. Then group the
  segments into `tracks[]` and feed the **existing** `renderCombinedTranscriptMarkdown`.
  The output format matches the Discord bot's.
- Quality caveat (stated, not hidden): this is attribution on mixed audio, so overlapping
  speech goes to one speaker. Discord's per-track transcripts are more accurate.

### D6 — Delivery

- *Working default:* reply to the organizer **by email** from `support@` via
  `smtp.zoho.com:465` (`nodemailer`), with the `.md` attached. The audio is only attached
  if it is under 20 MB.
- Optional: also DM a Discord user (`NOTETAKER_DISCORD_USER_ID`) by reusing the bot token.

## Environment (new, validated at load like `src/env.js`)

| Var | Required | Notes |
|---|---|---|
| `NOTETAKER_EMAIL` | yes | `support@spotslocal.com` |
| `NOTETAKER_APP_PASSWORD` | yes | Zoho app-specific password |
| `NOTETAKER_ALLOWED_ORGANIZERS` | yes | consent guard (D3) |
| `NOTETAKER_BOT_NAME` | no | default `SpotsLocal Recorder` |
| `NOTETAKER_IMAP_HOST` / `NOTETAKER_SMTP_HOST` | no | default Zoho hosts |
| `NOTETAKER_ADMIT_TIMEOUT_MIN` | no | default 10 |
| `NOTETAKER_DB_PATH` | no | default `<MEETINGS_DIR>/notetaker.db` |

## Phases

1. **Pipeline split.** Extract the transcription step from `bot.js`: audio plus speaker
   labels in, `.md` out. Discord behavior stays byte-identical, pinned by the existing
   tests.
2. **Intake + schedule** (D1–D3). Logs "would join" only. Fully unit-testable.
3. **Meet joiner + attribution** (D4, D5). First end-to-end.
4. **Zoom joiner** (web client).
5. **Delivery** (D6), then a minor version bump and docs per AGENTS.md.

## Risks

- **Meet guest blocking:** many Workspace orgs disallow or require approval for external
  guests. The host must click "Admit" every time. Mitigation: a Google account
  registered on `support@spotslocal.com`, signed in once with its browser profile kept
  (later option). Scripted password sign-in is not planned, because Google blocks
  automated logins.
- **UI drift:** selector changes break joining silently. Mitigation: a failed join emails
  the organizer ("could not join") and the selectors are isolated per platform.
- **Resources:** about 1–1.5 GB RAM and one CPU core per concurrent meeting.
  *Working default:* one meeting at a time, and overlapping invites are refused with a
  logged reason.
- **Legal:** auto-recording on invite does not remove the two-party-consent obligation
  noted in the README. The D3 guard and the join announcement are the mitigations.

## Open questions

1. Is the D3 allowlist right, or should every invite be recorded?
2. Should delivery be by email (default), Discord DM, or both?
3. Where does this run (host and RAM)?
4. Is a paid joiner (e.g. Recall.ai) acceptable instead of D4, to avoid the UI-drift risk?
