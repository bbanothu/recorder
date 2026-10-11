# Master Speaker Attribution Implementation Plan (v2.1.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label master-transcript lines with Discord display names by joining transcription segments to the speaking timeline the bot already computes, using the combined renderer's `**Name:** [mm:ss] text` line shape.

**Architecture:** Two new pieces — (1) `speaking-log.jsonl`, a JSONL sidecar written in the meeting dir as the SpeakingGate closes windows (append per `onStopped`, fsync-friendly, injectable fs in tests), and (2) a pure module `src/attribution.js` mapping segments to windows by midpoint anchors with overlap-amount tie-breaking. The master render path in `bot.js`/`transcribe.js` gains optional labels; zero/missing windows reproduce the current speakerless output byte-for-byte.

**Tech Stack:** Node ≥22.13 ESM, discord.js v14, `node --test` (TDD), jsonl via `node:fs` (no new deps), faster-whisper sidecar unchanged.

**Design doc (source of truth):** `.project/specs/master-speaker-attribution.md`

**Repo:** `C:\Users\wot38\Documents\GitHub\discord-meeting-recorder` — **branch: `feat/master-speaker-attribution`** (to be cut from `master` @ `c2fe20b` in Task 0; NOT yet created). All paths below are relative to the repo. Version before this feature: `2.0.0`; this ships as **`2.1.0`** (minor — behavior change in one transcript mode only, no env surface change) per AGENTS.md release pattern.

**No GATE EXCEPTION needed this time:** the audio path, env surface, and DB schema are untouched; every task below is RED→GREEN within its own file scope, so the full suite goes red only inside a single task and normal AGENTS.md discipline (green before commit) applies without exception.

**Existing patterns to follow (from AGENTS.md and src/):**
- DI for fs/time: speaking-log writes and transcript read go through injectable deps — tests never touch real files except in explicit jsonl round-trip cases with tmp dirs.
- Pure decision logic in its own module; `bot.js` glue thin.
- Doc + version + CHANGELOG in the release commit; heading matches package.json exactly.

---

## Acceptance criteria

1. MASTER session with transcription enabled produces a transcript with `**Name:**` prefixes on attributed lines; combined-mode output unchanged.
2. Overlap-tie segments render as unlabeled lines with a `⚠` marker regardless of `displayName`; no-window segments render exactly as today (no prefix, no marker).
3. A master session with zero speaking windows renders byte-identical to the v2.0.0 master transcript.
4. `speaking-log.jsonl` exists in every master session's meeting dir (created at session start, empty file if nobody speaks).
5. `npm test` green; combined-mode suites pass untouched; README/CHANGELOG updated; package.json 2.1.0.

## Out of scope

- Diarization (Option B), combined-renderer changes, env surface, DB schema, cron/concurrency/stats (v3.x roadmap).

---

## Task 1: Branch + baseline

Objective: Cut the working branch and confirm the shipping baseline.

Steps:
1. `git checkout master && git pull` (fast-forward check; report if remote moved).
2. `git checkout -b feat/master-speaker-attribution` (from the archived tree at or after `c2fe20b`).
3. Run `npm test` — Expected: 244 tests / 43 suites green (baseline verified on `master` @ `c2fe20b` post-2.0.0; any drift from this count is a blocker; report before proceeding).
4. If `git status --porcelain` non-empty, stop and report; do not build on dirty state.
5. No commit needed (branch creation only).

## Task 2: Speaking-window persistence (`src/speaking-log.js`)

Objective: JSONL sidecar capturing closed speaking windows; opened lazily per master session, one line per `onStopped`.

Files:
- Create: `src/speaking-log.js`, `test/speaking-log.test.mjs`

Steps:
1. Write failing tests (DI a write fn + now-fn; never touch real fs here):
   - `createSpeakingLog({ appendFile, sessionStartMs })` returns `{ recordWindow(userId, displayName, startMs, endMs) }`.
   - Each call writes `{"userId","displayName","startMs","endMs"}` as one '\n'-terminated JSON line; session-relative ms (`startMs - sessionStartMs`, `endMs - sessionStartMs`) where `sessionStartMs` is the value the caller fed from the clock anchor (spec Decision 7: `master.t0` — the exact value passed to `MasterMix.start()`). NO wall-clock `ts` field (spec Data model: session-relative start/end fully determine the window).
   - Subsequent calls append (no header, no trailing newline issues; file ends with `\n` after each line, including the last).
   - displayName may contain markdown/quotes/newline — round-trip safe (write JSON.stringify's escapes; no hand-rolled quoting).
   - zero windows → no file contents ever written (file created empty at session start by the caller, not by the log writer).
2. Run `node --test test/speaking-log.test.mjs` — Expected: RED.
3. Implement `src/speaking-log.js`: pure writer, no I/O beyond the injected `appendFile` (filepath chosen by caller).
4. Run — Expected: GREEN.
5. Run `npm test` — Expected: green (new suite only).
6. Commit: `feat: speaking-window JSONL writer for master sessions`

## Task 3: Wire the speaking log into master sessions (`src/bot.js`)

Files:
- Modify: `src/bot.js`, `test/bot.test.mjs`

Steps:
1. Write failing tests in `test/bot.test.mjs` (DI-style harness, same as 2.0.0 tests):
   - Master session: `gate.onStopped`-equivalent callback (drive `speakingStart/speakingEnd` via the harness) appends one window row to `<dir>/speaking-log.jsonl` (assert via injected append spy: path contains `speaking-log.jsonl`, payload has the right userId/displayName/offsets).
   - Combined session (default): no `speaking-log.jsonl` writes occur — spy asserts zero calls.
   -(Hard) `speaking-log.jsonl` file is created empty at master-session start (inject mkdir/ftouch or assert via dir-contents spy at session start).
2. Run — Expected: RED.
3. Implement in `src/bot.js`:
   - Master-only branch: at session start, append nothing but ensure `<dir>/speaking-log.jsonl` exists (touch; this test pins acceptance criterion 4 verbatim: "`speaking-log.jsonl` exists in every master session's meeting dir (created at session start, empty file if nobody speaks)"); call `master.start(recorder.startedAt)` passing the recorder's clock explicitly (spec Decision 7 implementation path — makes the JSONL zero and the audio zero trivially identical, eliminating the two-read drift), then construct the writer with `sessionStartMs = recorder.startedAtMs`; on `gate.onStopped`, call `speakingLog.recordWindow(userId, displayName, startMs, endMs)` with session-relative ms.
   - Combined sessions: writer never constructed (no file, no lines).
4. Run — Expected: green.
5. Run `npm test` — Expected: all green.
6. Commit: `feat: record speaking windows to speaking-log.jsonl in master sessions`

## Task 4: Pure attribution (`src/attribution.js`)

Files:
- Create: `src/attribution.js`, `test/attribution.test.mjs`

Steps:
1. Write failing tests, per spec Decision 2/3/5:
   - `attributeSegments(segments, windows)` — each segment `{start, end}` (s, float; faster-whisper contract), windows `{userId, displayName, startMs, endMs}` (ms).
   - Convert segment s → ms. Label rules:
     a. ≥1 window contains the segment midpoint: if exactly one → its displayName; if ≥2 (live crosstalk: midpoint inside simultaneous windows) → rank THOSE containers by overlap amount with the segment, unique winner → its name, strict tie → `{ displayName: null, ambiguous: true }` (⚠ marker) — NAMED test case: "two windows both contain the midpoint";
     b. NO window contains the midpoint → window with max overlap amount wins, if >0; strict tie in overlap → `{ displayName: null, ambiguous: true }` — NAMED test case: "no container, overlapping tie";
     c. zero overlap anywhere → `{ displayName: null, ambiguous: false }` (plain speakerless line, no marker);
     d. across ALL rules, the label carries `{ userId: <stable key>, displayName: <name at window close> }`.
   - Edge cases from the proposal's Verification matrix: containment, partial overhang, no overlap, crosstalk tie, trailing segment after last window, missing/garbage windows (empty/non-array → all labels null, no crash), segments before any window.
2. Run — Expected: RED.
3. Implement `src/attribution.js` (pure, no fs/time imports).
4. Run — Expected: green.
5. Run `npm test` — Expected: green.
6. Commit: `feat: pure speaking-timeline attribution module`

## Task 5: Renderer extension (`src/transcribe.js`)

Files:
- Modify: `src/transcribe.js`, `test/transcribe.test.mjs`

Steps:
1. Write failing tests:
   - `renderTranscriptMarkdown({ segments, language, sourceFile, labels })` — new optional `labels` array aligned 1:1 with segments (`{ displayName: string|null, ambiguous: bool }`).
   - Label present + not ambiguous → `**Name:** [mm:ss] text` line (same shape as combined renderer; markdown-escape the name via the existing `escapeMarkdownName` convention).
   - Label absent or displayName null and not ambiguous → current speakerless line byte-for-byte.
   - `ambiguous: true` → `⚠` prefix before the timestamp on an otherwise unlabeled line.
   - No `labels` param at all → output identical to v2.0.0 (regression pin: reuse the existing master-mode render test byte-exactly and add labels variants to a COPY, don't mutate the pinned test).
2. Run — Expected: RED.
3. Implement in `transcribe.js`; `renderTranscriptMarkdown` stays the single exported render path (no forked renderer).
4. Run — Expected: green.
5. Run `npm test` — Expected: green.
6. Commit: `feat: optional speaker labels in master transcript render`

## Task 6: Wire attribution into the stop-time master route (`src/bot.js`)

Files:
- Modify: `src/bot.js`, `test/bot.test.mjs`

Steps:
1. Write failing tests:
   - Master session, transcription on, speaking windows recorded → transcript render receives `labels` computed from parsing `<dir>/speaking-log.jsonl` (DI: inject a `readSpeakingLog` fn; test supplies windows, asserts the resulting labels array + md content name prefixes).
   - Zero/garbage windows (read fn returns []) → labels all null + no markers → md byte-identical to the current master shape.
   - `readSpeakingLog` throws (corrupt file) → defensive: log-only, unlabeled output, no throw into the fire-and-forget transcription path.
   - Combined sessions: the combined path renders through `renderCombinedTranscriptMarkdown`, a different function from the master's `renderTranscriptMarkdown`, so it can never receive the new `labels` param — assert only as a cheap negative pin that no `labels` key reaches any combined render call, preserving the combined byte-shape.
   - Clock alignment pin (spec Decision 7) — FIRST re-read the actual Task 3 commit to see which writer wiring landed before writing the test (the correct test form depends on it; do not guess from this plan's prose): (A) if Task 3 kept both clock zeros distinct, feed windows written against a nonzero-shifted zero (e.g. segments measure from `master.t0` = 0, windows relative to a 900 ms-shifted zero) and assert labels describe the correct speaker anyway — the implementation converts windows into the segment clock via the recorded `master.t0`; (B) if Task 3 wired `master.start(recorder.startedAt)` so the zeros are identical by construction, assert that invariant directly: writer `sessionStartMs === value passed to master.start()`. Write whichever variant matches; the plan intends (B).
2. Run — Expected: RED.
3. Implement: in the master branch of the stop-time transcription block, read + parse the jsonl (prev pattern: fs via DI), call `attributeSegments(t0.segments, windows)`, pass to `renderTranscriptMarkdown`.
4. Run — Expected: green.
5. Run `npm test` — Expected: all green.
6. Commit: `feat: attribute master transcripts via speaking timeline`

## Task 7: Docs + version + release (per AGENTS.md)

Files:
- Modify: `package.json` (2.0.0 → 2.1.0), `CHANGELOG.md`, `README.md`, `.env.example` (no env change — verify nothing stale; do not edit unless a comment is wrong).

Steps:
1. `package.json` → `2.1.0`.
2. `CHANGELOG.md` new `## [2.1.0] - <today's date>` heading (must match package.json exactly), under `### Added` — one bullet, reword freely as the worker drops it into the existing Keep-a-Changelog structure (the substance to preserve: master sessions label transcript lines with speaker display names in the `**Name:** [mm:ss] text` shape, via a per-session speaking timeline persisted as a `speaking-log.jsonl` sidecar in the meeting dir; ambiguous crosstalk overlaps marked `⚠`; no env changes; no breaking changes). Heading/content review gates catch any malformed copy, so the prose here is guidance, not literal.
3. README: update the master transcript description (was "speakerless"; now "speaker-labeled via speaking timeline, best-effort"); keep combined description untouched.
4. `.env.example`: leave unchanged (verify no stale master-transcript wording claims "speakerless").
5. Run `npm test` — Expected: green, exit 0.
6. Commit: `chore: release 2.1.0`
7. `git status --porcelain` — Expected: clean (no `.env`, no `discord-meetings/`).

## Task 8: Review + archive

Steps:
1. Walk acceptance criteria 1–5 against code/tests (superpowers:verification-before-completion).
2. `npm test` final green; confirm no combined-mode test was modified (git diff-vs-master should show zero hunks in combined-mode suites beyond import-time offsets from new files).
3. Spec-compliance review: every spec Key decision implemented (JSONL sidecar, midpoint anchor, ⚠ on tie, no legend, master-only scope, names-at-close).
4. Archive per the post-2.0.0 convention: copy `spec/` and `plan/` into `.project/done/master-speaker-attribution/{spec,plan}/` (sha-verify copies BEFORE `git rm` on originals, per the established archival protocol), commit as `docs: archive completed v2.1.0 spec+plan to .project/done/master-speaker-attribution`.
5. Merge/finish per superpowers:finishing-a-development-branch (operator does the merge; propose PR text if asked).
