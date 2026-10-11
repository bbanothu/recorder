# Design: Speaker Attribution on Master Transcripts (v2.1.0)

Status: **Approved** (user decisions 2026-09-21)

## Goal

When transcribing MASTER audio, label each transcript line with the Discord
display name of the person speaking — by joining transcription segments to the
per-user speaking timeline the bot already computes — via the same
`**Name:** [mm:ss] text` line shape the combined (per-user) renderer uses.

## Users / actors

- Operator: runs the bot; reads DM'd master transcripts; no new env vars required.
- Guild members: speak in voice channels; no new commands or interactions.
- Single bot instance, single-process session model (unchanged from 2.0.0).

## Key decisions (user-approved)

1. **Persist speaking windows as a JSONL sidecar file in the meeting dir**
   (`speaking-log.jsonl`, one `{userId, displayName, startMs, endMs}` object
   per line, appended on `gate.onStopped`). Chosen over in-memory: survives a
   process crash with the timeline intact even if audio is partially lost, and
   doubles as the foundation for a future "Option C" timeline file next to the
   transcript. Flush cadence: append+fsync per window close (windows are ~1/s
   at most; fsync cost negligible vs. ffmpeg/opus work). Accepted deviation
   (task-2 review): the landed implementation uses plain `appendFile` without
   fsync — JSONL append is the same syscall cost class, a crash loses at most
   tail windows, and degraded attribution is already an accepted Risks
   mitigation.
2. **Anchor rule: segment midpoint.** `attributeSegments` maps each segment's
   midpoint `(segStart + segEnd) / 2` to the speaking window containing it;
   when no window contains the midpoint, pick the window with the greatest
   overlap amount with the segment (deterministic, testable); when overlap is
   zero, the line stays unlabeled.
3. **Crosstalk tie-breaking:** all candidate windows ranked by overlap amount;
   strict tie in overlap amount → line rendered with `displayName: null` BUT
   with a `⚠` marker appended before the timestamp, so ambiguous ownership is
   visible rather than silently guessed. (User picked the ⚠ variant.)
4. **No speaker legend in the header.** Attributed master transcripts keep the
   1.6.0 master file shape byte-for-byte, changing only that lines acquire
   `**Name:**` prefixes when attribution resolves cleanly.
5. **Names resolved at window-close time, keyed by `userId`.** The gate
   callback writes `displayName` (as seen at close) into the window row; the
   attributor emits whatever name a window carries. A guild rename
   mid-session therefore appears in the transcript as the name at the time of
   speaking — acceptable, documented, no extra UI. (Taxonomy decision from
   proposal Q5.)
6. **Release: v2.1.0, branch `feat/master-speaker-attribution`.** Minor
   version (no env surface change, no breaking behavior; only the master-mode
   transcript output shape changes).

7. **Clock anchor (verified against src): the JSONL clock zero is `master.t0`**
   (the `MasterMix.start(atMs)` argument), NOT `recorder.startedAtMs`, and NOT
   the wall-clock session stamp. Grounded in code: `bot.js` creates the
   recorder with `startedAt: now()` (recorder.js:56 pins `startedAtMs`) and
   calls `master?.start()` immediately AFTER with no argument
   (master-mix.js:62 defaults to a SEPARATE `this.now()` read); master-mix
   builds the WAV with `frameIndex = round((atMs - this.t0)/20)` — so
   faster-whisper segment times measure from `master.t0`, not from
   `recorder.startedAtMs`. The two reads can drift by scheduling delay;
   attributing against the wrong zero shifts EVERY label by that constant.
   Rule: the JSONL writer's `sessionStartMs` MUST be fed exactly the value
   `MasterMix.start()` was called with, and the stop-time python sidecar's
   segment clock is assumed to share that zero. Task 6 adds a nonzero-offset
   test pinning this alignment (or, if the plan's implementation must change
   `master.start()` to receive `recorder.startedAtMs` to make the two clocks
   trivially identical, that change is IN scope and must carry its own test).

## Data model

`speaking-log.jsonl` — one JSON object per closed speaking window:

```json
{"userId":"123…","displayName":"Alice","startMs":3200,"endMs":7450}
```

- `startMs`/`endMs` are **session-relative** (ms since `master.t0` — see
  Decision 7 for why this is the anchor and why it is not
  `recorder.startedAtMs` or a wall-clock field; no wall-clock `ts` field is
  stored — session-relative start/end fully determine the window).
- Written only in MASTER sessions (a combined session already has per-user
  audio; its attribution is per-track by construction).

## Pipeline (stop-time, post-transcription, pre-render)

1. stopSession (master route, transcription on) reads
   `<dir>/speaking-log.jsonl` via an injectable reader (DI: tests never touch
   real fs). Parse failures / missing file → `windows = []` → fallback
   speakerless render (current 1.6.0 shape), log-only.
2. `attributeSegments(masterSegments, windows)` → labels:
   - For each segment `[segStart, segEnd]`: collect ALL windows whose span
     CONTAINS the segment midpoint. If ≥2 contain the midpoint (live
     crosstalk), rank those containers by overlap amount with the segment;
     strict tie → `⚠` + unlabeled; unique winner → that window's name. If
     exactly one container → its name. If NO window contains the midpoint →
     fall through to the overlap rule below; `⚠` + unlabeled on tie
     (identical ranking rule, stated once for both paths).
3. `renderTranscriptMarkdown` gains an optional `labels` param
   (`{segIndex, displayName|null, ambiguous}[]` or equivalent); unlabeled +
   non-ambiguous behaves exactly as today, so zero-attribute sessions produce
   byte-identical output to v2.0.0.

## Out of scope

- Speaker diarization from audio (pyannote-style) — future Option B.
- `/record_type` surface changes (RECORDING_TYPE semantics unchanged).
- Rewriting the combined per-user transcript shape (must stay untouched).
- Cron/retention features, concurrency, stats (v3.x roadmap).
- Backfilling attribution for transcripts produced by older versions.

## Acceptance criteria

1. MASTER + transcription-on session produces a transcript whose lines carry
   `**Name:**` prefixes for segments whose midpoints fall inside a speaking
   window; combined-mode output unchanged.
2. Overlap-tie segments show `⚠` and no name; no-window-covers segments show
   no prefix (identical to legacy).
3. A session with zero confirmed speaking windows renders byte-identical to
   the current speakerless master output.
4. `speaking-log.jsonl` exists in the meeting dir for every master session
   (even if empty), one JSON row per closed window, assuming fs writes are
   injectable in tests.
5. `npm test` green; combined-mode suites untouched and passing; docs
   (README/CHANGELOG) updated; package.json 2.1.0.

## Risks / tradeoffs

- Whitespace/overlap inaccuracy from gate debounce (~1 s confirm, ~1 s
  silence): windows can trail segment boundaries by up to ~2 s. Mitigation:
  overlap-amount ranking is deliberately permissive (a 0.4 s overlap still
  wins if nothing else overlaps); midpoint-containment handles the common
  case. Residual mislabels are a documented best-effort limitation.
- JSONL fs growth: negligible (each row <100 B; a 2 h meeting ≈ a few KB).
- Crash loss of a window flush loses only that row; attribution degrades
  gracefully (unlabeled lines) — no transcript is lost.
- Midpoint anchoring can mislabel a very short interjection whose midpoint
  strays past a boundary; accepted for v2.1.0, revisit with Option B
  (diarization) later.

## Branch

`feat/master-speaker-attribution`, cut from `master` after the 2.0.0 archive
cleanup commit (`c2fe20b`).
