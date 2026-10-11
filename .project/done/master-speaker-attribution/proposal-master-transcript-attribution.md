# Proposal: Discord name attribution on MASTER transcripts (Option A — timeline anchoring)

Status: brief for planner — not yet designed or approved.
Origin (user goal): "when transcribing MASTER audio, add Discord name tags per user."

## Problem

MASTER-mode sessions mix all voices into one blended WAV. The master transcribe
route (`src/bot.js` stopSession, `transcribeMode: 'master'`) therefore renders
speakerless transcript lines (`displayName: null` → no prefix). The identity
data already exists in-process: `speaking-gate.js` emits de-noised
`speakingStart(userId, displayName)` / `speakingEnd(userId)` windows with real
timestamps, but they are only log lines — never persisted, never joined to the
transcript. Option A = join transcript segments to the speaking timeline. No
audio/diarization work.

## Recommended approach

1. Persist per-user speaking windows during every MASTER session
   (`{userId, displayName, startMs, endMs}`), either as JSONL in the meeting
   dir or held in session memory — planner decision.
2. New pure module `src/attribution.js`:
   `attributeSegments(masterSegments, speakingWindows) -> labeled segments`.
   Anchor = segment midpoint; map to the window containing/best-overlapping
   the midpoint; tie-break by overlap amount, fallback unlabeled.
3. Extend the master render path (`transcribe.js`) to accept
   `speakerWindows`; attributed MASTER output uses the SAME line shape as
   `renderCombinedTranscriptMarkdown` (`**Name:** [mm:ss] text`). Markdown
   escaping of names is already solved (`escapeMarkdownName`).

## Why this fits the repo (grounded in current code)

- `speaking-gate.js` already computes debounced windows with userId +
  displayName (`speakingStart`/`speakingEnd`).
- The combined renderer already does timestamp-interleaved, name-prefixed,
  markdown-escaped output; master-only shape differs only by
  `displayName: null`.
- Attribution is pure decision logic → own module (AGENTS.md convention),
  `bot.js` stopSession stays thin.

## Constraints for the planner

- Keep the existing 1.x semantics intact: per-user `combined` mode must not
  change; attribution applies to the master route only.
- No new runtime dependencies, no model downloads (unlike Option B
  diarization, explicitly out of scope here).
- Backwards compatibility: when speaking windows are missing (partial file /
  recording session started before uptime window), the master transcript falls
  back to the existing speakerless output.
- Performance and size must not change: attribution is post-processing on
  already-produced data; the master mix keeps `-b:a 24k`; no new files unless
  persistence option requires one.

## Open design questions for the planner

| # | Question | Notes |
|---|---|---|
| 1 | Windows persistence: sidecar file (JSONL) vs in-memory+config DB | persistence doubles as future Option C (timeline file next to transcript) |
| 2 | Attribution anchor: segment midpoint vs window-overlap weighting | midpoint = deterministic + testable; overlap weighting = more robust to lookahead truncation; recommend midpoint + overlap tie-breaker |
| 3 | Social crosstalk: ranking windows when multiple cover a segment | current language: rank by overlap share; tie → unlabeled and mark ⚠ in text? |
| 4 | Push-shift: gate debounce adds latency (~5s?) after a user stops | transcription segments can trail gate ends; needs one-sided padding rule |
| 5 | Anchoring taxonomy: names vs userId vs fallback to userId if link count is 0 | displayName may change mid-session (guild rename); pick stable key (userId) and set displayName at stop |
| 6 | `transcribeMode: master` vs `combined` interaction | verify master confuses both keys — plan needs a routing block over both |
| 7 | GUI notes: session meta in transcript header | add speaker legend (userId → displayName) or keep file simple |

## Out of scope

- Speaker diarization from audio (pyannote-style) — future option B.
- `/record_type BOTH` (dual mode) — unchanged.
- Rewriting the combined (per-user) transcript shape.

## Effort estimate

Rough: 1 new pure module + speaking-window persistence + renderer extension +
tests (~6–8 cases). Comparable to a minor (x.y.0) release; behavior change only
in the master-transcribe output shape.

## Risks

| Risk | Mitigation |
|---|---|
| Overlap-heavy crosstalk → wrong labels | rank windows by overlap; tie → unlabeled + browsable fallback (speaking-log or Option C add-on) |
| Gate launch delay after stop | add one-side padding margin in attribution (design decision) |
| displayName changes mid-session | key on userId, resolve names at session end |
| Combined-mode behaviors regression | tests scoped to master-route only; combined suites stay untouched and must stay green |

## Verification

- Attribution matrix tests: exact containment, partial-overlap, no-overlap,
  crosstalk tie, trailing segment after last window, session-start offset math
  (`startedAtMs − sessionStartMs — already the convention in the combined
  renderer via Decision 3/5`).
- Master-mode transcript regression: same test verifies unchanged shapes
  (combined mode, master mode with no windows).
- Full `npm test` green; new tests cover the new route.
