# Phone recorder — on-device clipping and transcription (v2)

Extends `phone-recorder.md`. That spec made the **server** required for every
clip (ffmpeg concat + Whisper over Tailscale). This spec removes that
requirement: recording and clipping work with the phone alone; the server
becomes an opt-in "offload transcription" toggle instead of a prerequisite.

## Why

User report: "make the recording local, i.e on the device, I can't seem to
clip it." The `Clip` button was disabled until `serverUrl` + `token` were set
in Settings, because clip = ffmpeg concat + Whisper on the user's machine.
Nothing about recording itself was ever server-dependent — only clipping was.

## Decisions (agreed 2026-10-08)

| Topic | Decision |
|---|---|
| Scope chosen | Full on-device transcription (not just audio-only clipping) — user picked this explicitly over the smaller option |
| Clip trigger for transcription | Only clipped chunks get transcribed (per user's notes), not every recorded minute — cheaper on battery than the server's "transcribe everything uploaded" model |
| Audio merge | Deferred (still Track B). v1 clip keeps the per-minute files as an ordered sequence instead of one physical file — ffmpeg-kit-react-native and react-native-ffmpeg are both deprecated/unmaintained on npm (checked 2026-10-08), so there is no drop-in on-device ffmpeg. Now that `react-native-audio-api`'s decode is wired in and confirmed (below), merging is "decode every chunk, concatenate the Float32 PCM, `pcmToWav` once" — mechanically simple once someone's holding a dev-client build to actually hear the result |
| On-device STT | `whisper.rn` (ggml Whisper). Requires WAV/16-bit-PCM input — it does not decode AAC/MP4 itself. API confirmed against its own source in `mobile/node_modules/whisper.rn` (not docs, not guessed): `initWhisper({ filePath }) → ctx`, `ctx.transcribe(wavPath, opts) → { promise } → { result, language, segments: [{ text, t0, t1 }] }`, `t0`/`t1` in centiseconds |
| AAC → PCM decode | `react-native-audio-api` (Software Mansion). Implemented (`mobile/src/native/ondevice-transcribe.js`): `decodeAudioData(uri, sampleRate)` (confirmed against `core/AudioDecoder.ts` in the installed package — takes a local `file://` URI directly, resamples during decode) → `AudioBuffer.getChannelData(0)` → Float32 PCM → `floatToInt16Pcm`/`pcmToWav` (`mobile/src/core/wav.js`, pure, tested) → a temp WAV for whisper.rn |
| Native build | Both libraries are native modules: **Expo Go can no longer run this app's transcription** once they're wired in — confirmed by actually re-bundling against the running dev server rather than assumed: `react-native-audio-api` throws *at import time* when its native binding is missing (not just when called, unlike whisper.rn), so its import is deferred with a dynamic `import()` inside the one function that needs it — otherwise it crashed every screen, not just transcription. Needs `npx expo prebuild` + a dev client (EAS or local) to actually run; in Expo Go, Clip still works (local audio, no transcript) and tapping it now fails gracefully per-chunk ("native module could not be found") instead of taking the app down. `expo-sqlite` does *not* need this — it works in Expo Go |
| Retention vs. the "6-hour clip after a 1-hour clip" scenario (Concerns section) | No new mechanism needed: `clipRange()` already caps any retroactive clip at the current window (`mobile/src/core/chunks.js`). You can never clip further back than the window allows, so a chunk already swept for being older than the window was never clippable to begin with — the scenario described (wanting a 6 h clip after already taking a 1 h clip) only arises if the window is ≥ 6 h, in which case the chunks are, by definition, still kept. Nothing to resolve beyond keeping that invariant |
| Long-recording nudge | In-app banner on Home once `since` passes a threshold (default 3 h), no push notification yet — the app only records in the foreground today, so a banner is seen already; a scheduled push is a Track B item once background recording exists |
| Web build | Out of scope for this change. `clip()` still requires the server on web (unchanged); native (iOS/Android) gets the local path |

## Architecture (Track A — ships now, Expo Go)

```
mobile/src/core/chunks.js        + chunksOverlapping(names, fromMs, toMs)   [pure, tested]
mobile/src/core/clips-store.js   clips table (id, fromMs, toMs, dir, chunkCount, createdAt)
                                  DI'd on a DatabaseSync-shaped db          [pure, tested
                                  against real node:sqlite, same pattern as src/phone/store.js]
mobile/src/native/sqlite.js      expo-sqlite → DatabaseSync-shaped adapter [native, unverified
                                  here — no simulator in this environment; exact expo-sqlite
                                  property names confirmed against docs, not against a running app]
mobile/src/native/sqlite.web.js  null (web keeps requiring the server, unchanged)
mobile/src/native/local-clips.js copies the overlapping pending/ chunk files into
                                  <documents>/clips/<id>/, inserts the clips-store row
```

`RecorderContext.clip()`: flush the current minute, then **always** build a
local clip (native only) by copying the window's chunk files; if the server
is *also* configured, it still uploads and asks for a server transcript in
parallel, best-effort — the local clip never waits on that. `Settings` keeps
the server fields but relabels them as optional ("offload transcription to
your server").

A local clip has no transcript yet in Track A — just the ordered minute
files, shareable one at a time. The clip screen says so plainly.

## Architecture (Track B — implemented, not verified on a device)

Per-clip, resumable, serial transcription, triggered by the clip itself
(`mobile/src/core/transcription-queue.js`, `mobile/src/native/
ondevice-transcribe.js`):

- For each file in `<documents>/clips/<id>/` **without** a `<name>.segments.json`
  sidecar (same convention `src/phone/service.js` already uses), in order:
  decode AAC → PCM (`react-native-audio-api`'s `decodeAudioData`, confirmed
  against its own source — takes a local `file://` URI directly, resamples
  to 16 kHz during decode), `floatToInt16Pcm` + `pcmToWav` (pure, tested) to
  a temp WAV, `whisper.rn`'s `transcribe()` (confirmed against its own
  source), write the sidecar, move to the next file.
- Resumability is the filesystem, not a new DB table: a sidecar existing
  **is** "done". An app kill mid-clip just means some files have a sidecar
  and some don't; relaunch resumes by re-scanning the same directory. No
  separate queue table needed — this also means `clips-store` above does not
  need a state column; reading a clip's transcript is "stitch whatever
  sidecars exist right now," which fills in live as the queue works.
- `react-native-audio-api` installs its native binding *at import time* and
  throws immediately if it's missing — unlike whisper.rn, which only fails
  when actually called. Found by re-bundling against the live dev server: a
  static top-level import crashed every screen in Expo Go, not just
  transcription. Fixed with a dynamic `import()` inside `decodeAacToWav`
  itself, so only an actual transcribe attempt fails (gracefully, into that
  chunk's sidecar) before a dev-client build exists.
- Still open: keeping the queue running across an app background/kill
  (`expo-task-manager` + `expo-background-task`, needs real-device
  verification — iOS background time budgets are short; Android should use
  a foreground service with a visible notification, same reasoning the
  original spec used for recording itself) and a single merged audio file
  (mechanically: decode every chunk, concatenate the Float32 PCM, `pcmToWav`
  once — straightforward now that decode is wired, just not built yet).
- Everything above is written against each library's real, installed
  source (`mobile/node_modules/whisper.rn`, `mobile/node_modules/
  react-native-audio-api`) — not guessed, not docs-only. What's still
  unverified is whether it actually transcribes correctly end to end: no
  iOS simulator is available here (`xcrun simctl` fails) and no Android
  emulator is configured, so wiring these two native libraries' exact calls
  without a way to run them would be shipping unverified native code as if
  it were tested. Track A ships tested; Track B is scaffoldable-but-untested
  until the user builds a dev client and runs it on a real device.

## Next steps for the user

```bash
cd mobile
npx expo install expo-sqlite      # already done by this change
# Track B, when ready:
npx expo install react-native-audio-api
npm install whisper.rn
npx expo prebuild                 # generates ios/ and android/ — Expo Go stops working after this
npx expo run:ios   # or: eas build --profile development --platform ios
npx expo run:android
```
