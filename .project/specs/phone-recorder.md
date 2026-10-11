# Phone recorder — rolling transcript with retroactive clips

## Goal

A React Native app (iOS + Android) that, once the user starts it, records
everything the phone's microphone hears. Audio goes to the user's own machine,
which transcribes it with the existing faster-whisper sidecar. Anything older
than the user's window (30 min / 1 h / 12 h) is deleted on both ends unless the
user **clips** it: "save the transcript of the last 30 minutes", after the fact.

Compute is local: no cloud transcription, no third-party server. Phone and
server talk over **Tailscale**.

## Decisions (agreed 2026-10-06)

| Topic | Decision |
|---|---|
| Platforms | iOS and Android together (Expo, one JS app; native recorder per platform) |
| Transport | Tailscale; the server binds to the tailnet only |
| Retention | The window deletes audio **and** transcripts on phone and server; only clips are kept |
| Location | This repo, branch `phone-recorder` (from `google`): app in `mobile/`, server in `src/phone/` |
| Upload cadence | Hourly batches; **a clip uploads everything pending immediately** |
| Speakers | None in v1 (timestamps only). Diarization / voice naming is a later phase |

## Architecture

```
phone (Expo app)                                  your machine (Tailscale 100.x)
┌─────────────────────────────┐                   ┌──────────────────────────────────┐
│ recorder: 1-min AAC files   │  hourly batch     │ phone-server (node:http)          │
│ (background / fg service)   │ ───────────────►  │  PUT chunk → disk + phone.db       │
│ pending/ queue              │  POST /chunks     │  queue → runTranscription (Whisper)│
│ local retention sweep       │                   │  per-chunk segments JSON           │
│                             │  POST /clips      │  clip → transcript-<…>.md (kept)   │
│ Clip: last 5/15/30/all      │ ───────────────►  │  retention sweep (window)          │
│ Clips list → transcript     │ ◄───────────────  │  GET /clips/:id                    │
└─────────────────────────────┘                   └──────────────────────────────────┘
```

### Chunks

- The phone records **1-minute** files (AAC-LC in `.m4a`, mono, 16 kHz,
  32 kbps ≈ 14 MB/h). AAC because both OS recorders produce it natively;
  the server's ffmpeg canonicalisation (`transcodeToWav`) already accepts any
  input.
- A chunk is identified by `(deviceId, startedAtMs)` from the phone's clock.
  Uploads are idempotent: re-sending a chunk the server already has is a no-op.
- Rotating the recorder every minute leaves a gap of ~100 ms between files.
  Accepted for v1; a native gapless recorder is a later upgrade.

### Server (`src/phone/`, `npm run phone-server`)

Same conventions as the rest of the repo: node:http (no framework),
node:sqlite, DI for clock/timers/transcriber, env validated at load.

- `phone.db` (own file): `chunks(device_id, started_at, duration_ms, path,
  state: received|transcribed|failed, segments_path)`, `devices(device_id,
  window_minutes, updated_at)`, `clips(id, device_id, from_ms, to_ms,
  created_at, md_path, state)`.
- Files: `<MEETINGS_DIR>/phone/<deviceId>/chunks/<startedAt>.m4a` and
  `<startedAt>.segments.json`; clips under `<MEETINGS_DIR>/phone/<deviceId>/clips/`.
- Transcription: one serial queue over the existing `runTranscription`
  (`WHISPER_PYTHON`, `WHISPER_MODEL`). Segment times are shifted by the chunk's
  start so everything is on one absolute clock.
- **Clip** = render `transcript-<from>.md` from every chunk overlapping
  `[fromMs, toMs]` (segments filtered to the range) with the existing
  `renderCombinedTranscriptMarkdown`. A clip waits until those chunks are
  transcribed (state `pending` → `ready`). Clip audio is concatenated into
  `clip-<from>.m4a` so it survives the sweep.
- **Retention sweep** every minute: delete chunks (audio + segments) whose end
  is older than `now − window`. Clips are separate files and are never swept.
- Auth: `Authorization: Bearer <PHONE_TOKEN>` on every request (required env;
  Tailscale is the network boundary, the token stops other tailnet devices).

#### API (v1)

| Method | Path | Body / query | Result |
|---|---|---|---|
| `PUT` | `/v1/devices/:id` | `{ windowMinutes }` (30, 60, 720) | `{ windowMinutes }` |
| `PUT` | `/v1/devices/:id/chunks/:startedAt` | raw audio, `?durationMs=` | `201` new / `200` already had it |
| `POST` | `/v1/devices/:id/clips` | `{ fromMs, toMs }` | `{ clipId, state }` |
| `GET` | `/v1/devices/:id/clips` | | list |
| `GET` | `/v1/devices/:id/clips/:clipId` | | `{ state, markdown }` |
| `GET` | `/v1/health` | | `{ ok, version }` |

### App (`mobile/`, Expo with a dev client)

- Screens: **Home** (start/stop, window picker, status: recording since,
  pending uploads, last upload, server reachable), **Clip** (last 5 / 15 / 30 min /
  whole window), **Clips** (list → transcript, share as `.md`), **Settings**
  (server URL on the tailnet, token, device name).
- Recorder: first try `expo-audio` background recording (iOS `audio`
  background mode; Android foreground service type `microphone` with a
  persistent notification). If it cannot rotate files reliably in the
  background, write a small Expo native module per platform.
- Interruptions (calls, Siri, other apps) end the segment; the recorder
  resumes automatically when the session is returned.
- Upload queue: files in `pending/`; hourly upload; on success the local file
  is deleted. Local sweep deletes pending files older than the window (so an
  offline phone never grows past the window).
- Clip: upload everything pending first, then `POST /clips`, poll until ready.

## Phases

1. **Server** (`src/phone/`): store, upload, transcription queue, clips,
   retention, auth. TDD; fully testable on this machine with fixtures.
2. **App skeleton**: Expo + dev client, settings, foreground recording into
   1-min files, manual upload, clip → transcript view. Android first build
   on this machine (Android SDK present); iOS via EAS Build.
3. **Background**: Android foreground service, iOS background audio,
   interruption recovery, hourly upload, local retention.
4. **Polish**: clip range slider, share/export, server health indicator.
5. **Later**: per-clip voice grouping + manual naming; optional opt-in
   voiceprints (biometric-privacy constraints: see the brainstorm notes).

## Status

- Phase 1 (server): done. Tested end to end with real AAC chunks and Whisper.
- Phase 2 (app skeleton): done in `mobile/` (Expo SDK 57, expo-router, expo-audio,
  expo-file-system, expo-secure-store). Pure logic in `mobile/src/core/` is
  covered by `test/mobile-core.test.mjs`; both platforms bundle. Not yet run on a
  device. `expo-audio` 57 exposes `allowsBackgroundRecording` and an
  `enableBackgroundRecording` plugin option, so phase 3 may need no custom
  native module.
- Build constraint found: Hermes' `hermesc` aborts on this machine (16 KB
  pages, "Unsupported system page size"), so release bundles and local
  Android builds go through EAS Build. Expo Go development is unaffected.

## Constraints and risks

- **iOS builds need macOS/Xcode.** This machine is Linux (aarch64), so iOS goes
  through EAS Build (Expo account) and installing on a device needs an Apple
  Developer account. Android builds and installs locally with `adb`.
- The OS can still stop recording (force-quit, reboot, OEM battery killers);
  the app must show clearly when it is not recording.
- Recording people without consent is illegal in two-party-consent states; the
  first-run screen says so. Short retention plus local-only processing is the
  privacy posture.
- Battery: continuous AAC encoding is cheap; transcription runs on the server.
