# Git Tag on build-and-push.sh Implementation Plan (v2.1.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `./build-and-push.sh` creates a git tag on the current branch HEAD with the version it just built and pushed, so every Docker image version is 1:1 traceable to a git commit.

**Architecture:** Script-only change in `build-and-push.sh` — after the existing docker push step, tag `HEAD` with the resolved `${VERSION}` and print the manual push hint. Git itself provides the collision check (`git tag` refuses to overwrite); the script wraps it in an idempotent already-exists guard so a re-run doesn't fail. No `src/` changes, no runtime behavior change.

**Tech Stack:** Bash (existing script), git, Docker, node (already a dependency of the script for reading package.json). No new deps.

**Design doc (source of truth):** `.project/specs/git-tag-on-build-and-push.md`

**Repo:** `C:\Users\wot38\Documents\GitHub\discord-meeting-recorder` — **branch: `feat/git-tag-on-build-push`** (cut from `feat/master-speaker-attribution` @ `c795bd1` in Task 1 — that branch holds the shipped 2.1.0 code the operator will tag next; do NOT cut from `master`, which may lag). Version before this feature: `2.1.0`; this ships as **`2.1.1`** (patch — tooling-only, no API/env surface change) per AGENTS.md release pattern.

**Existing patterns to follow (from AGENTS.md):**
- Conventional commit (`feat:` for a new capability, `chore:` for tooling-only) — this change is `feat:` because it changes the release workflow's observable behavior.
- Code + docs + version together in the release commit.
- `npm test` green before commit.

---

## Acceptance criteria

1. `./build-and-push.sh` on a branch whose `package.json` is `2.1.1` — after a successful docker push — creates a local git tag `2.1.1` pointing at current `HEAD`; script output shows `==> Tagged HEAD (<short-sha>) as 2.1.1` followed by the manual-push hint line.
2. Re-running with a version whose tag already exists does NOT fail the script — prints "already exists — leaving it alone (no overwrite)" and continues; exit code stays 0; the existing tag is not modified.
3. Explicit version arg (`./build-and-push.sh 9.9.9`) tags `9.9.9` specifically and prints that same hint.
4. `npm test` green (285 tests / 45 suites baseline at this branch point); `git diff vs feat/master-speaker-attribution` shows zero `src/` changes; package.json `2.1.1`; CHANGELOG entry present; heading matches package.json.

## Out of scope

- Auto-pushing the tag to origin (user declined — manual `git push origin <tag>` only, printed as a hint).
- Tag formats other than plain semver, annotated/signed tags.
- CI/CD wiring; retagging/moving existing tags.

---

## Task 1: Branch + baseline

Objective: Cut the working branch and confirm the shipping baseline.

Steps:
1. Confirm on `feat/master-speaker-attribution` (or its eventual merged target — if it has merged to `master` by the time work starts, cut from `master` instead; the plan tests keep working either way). Verify clean tree: `git status --porcelain` — Expected: empty.
2. `git checkout -b feat/git-tag-on-build-push`
3. Run `npm test` — Expected: all green (baseline at branch cut: 285 tests / 45 suites @ `c795bd1`; any drift is a blocker; report before proceeding).
4. No commit needed (branch creation only).

## Task 2: Red testing for the tag behavior

Objective: The tagging step is shell logic inside an existing script, not a Node module — so the RED step is a behavioral verification harness, not `node --test`. We write it as a small bash test script that runs `build-and-push.sh` against a MOCKED docker (stub `docker` on PATH), so no real build/push happens in CI or dev runs.

Files:
- Create: `test/scripts/build-and-push.test.sh` (plain bash, exit-nonzero on first assertion failure — NOT part of `npm test` yet; wired in Task 2 step 5)

Steps:
1. Write the failing bash test script with four cases:
   - **Case A (tag created):** stub `docker` on PATH as a fake binary that accepts any `docker build|tag|push|compose` invocation and exits 0; run `build-and-push.sh` in a temp clone whose `HEAD` is a known commit; assert (a) exit code 0, (b) `git tag -l` contains `2.1.1` (read from the test fixture's package.json) — NOT `v2.1.1`, (c) tag points at the temp clone's `HEAD` (`git rev-list -n1 2.1.1` equals the known short SHA), (d) stdout contains `==> Tagged HEAD (<sha>) as 2.1.1` and the `git push origin 2.1.1` hint line.
   - **Case B (already tagged):** pre-create the tag in the temp clone (pointing at HEAD), re-run the script; assert exit 0, stdout contains "already exists — leaving it alone", and `git rev-parse 2.1.1` still points at the same commit (no move).
   - **Case C (explicit version):** run `build-and-push.sh 9.9.9`; assert tag `9.9.9` exists on HEAD and stdout hints `git push origin 9.9.9`.
   - **Case D (tag elsewhere):** pre-create the tag pointing at a DIFFERENT commit than HEAD, run script; assert the warning line appears, exit code is 0, and the tag was NOT moved (`git rev-parse 2.1.1` unchanged).
   - IMPORTANT: the temp clone's package.json version control is per-case — Case A's fixture ships version `2.1.1`, Cases B/C ship a version matching their own tag expectations, so tests do not implicitly depend on the repo's real version at any future moment.
2. Mktemp-based setup/teardown: each case gets its own `mktemp -d` clone (git init + fixture files + package.json + a single commit); stub `docker` via a writable dir prepended to PATH containing a fake `docker` script. No network, no real image builds.
3. Make the file executable (`chmod +x`).
4. Run it manually: `bash test/scripts/build-and-push.test.sh` — Expected: FAIL on Case A (script has no tagging step yet) with a clear message like "expected tag 2.1.1 to exist, not found".
5. Wire it into `npm test`: add `"test:scripts": "bash test/scripts/build-and-push.test.sh"` to package.json scripts AND extend the `test` script to `"node --test && npm run test:scripts"` so the release gate (Task 3 steps) and AGENTS.md checklist automatically cover it hereafter.
6. Commit: `test: add build-and-push.sh git-tag behavioral harness (RED)` — commit message carries `(WIP: suite red — tagging step not yet implemented)` suffix only if `npm test` as a whole fails at this point; if the node suite is still green and the new script is merely failing standalone, note it in the commit body instead of the message suffix (this task's RED is inside the new bash file only, because the node suite is untouched).

## Task 3: Implement the tagging step (GREEN)

Files:
- Modify: `build-and-push.sh`

Steps:
1. Implement per the spec's Behavior section, placed immediately AFTER the existing `docker push` of `:latest` and BEFORE the `DIGEST=...` line, with the exact semantics: check `git rev-parse -q --verify "refs/tags/${VERSION}"`; if present → warn-and-continue with the exact "already exists — leaving it alone (no overwrite)" wording; if absent → `git tag "${VERSION}"` then print `==> Tagged HEAD ($(git rev-parse --short HEAD)) as ${VERSION}`, followed by the hint line `    Push the tag to the remote when ready:  git push origin ${VERSION}`.
2. Edge the exit code: do NOT let the tagging step be the thing that fails a successful push (docker push exit 0 + git tag refusal must still exit 0 with the warning). Use the if/else guard, never `git tag ... || die`.
3. Run the bash harness — Expected: GREEN (all four cases).
4. Run `npm test` — Expected: full green (node suite untouched + bash harness green).
5. Sanity-check the arg-vs-package.json binding once manually in the real repo (no push): `./build-and-push.sh 9.9.9` — Expected: script creates tag 9.9.9 locally, attempts real docker build. If that's too heavy on this machine, validate the signaled flag on a THROWAWAY clone in the temp harness only (the bash harness Case C already proves it — prefer skipping the real-run here and leave the operator-run for after merge). Do NOT actually run docker build on the dev machine as part of this task.
6. Delete the accidental tag if step 5 created one on the real repo: `git tag -d 9.9.9`.
7. Commit: `feat: tag git HEAD with the built version in build-and-push.sh`

## Task 4: Version bump + CHANGELOG + full gates (per AGENTS.md)

Files:
- Modify: `package.json` (2.1.0 → 2.1.1), `CHANGELOG.md`

Steps:
1. `package.json` → `2.1.1`.
2. `CHANGELOG.md` new `## [2.1.1] - <today's date>` heading (must match package.json exactly), under `### Added` — one bullet: "`build-and-push.sh` now tags the current git branch HEAD with the version it built (local tag only; push manually). Idempotent on re-run (existing tags left alone)." Prose is guidance for the release worker, not literal copy — reword freely into the Keep-a-Changelog structure.
3. Run full gates:
   - `npm test` — Expected: exit 0 (285 node + bash harness green).
   - `git status --porcelain` — Expected: clean, no `.env`, no `discord-meetings/`.
4. Commit: `chore: release 2.1.1` (code + docs + version together, per AGENTS.md).

## Task 5: Review + archive

Steps:
1. Walk acceptance criteria 1–4 against the script + test harness (superpowers:verification-before-completion). Criterion 1's docker-push leg can only be proven in a real run by the operator — the bash harness's stubbed-docker run fulfills it in CI; note this explicitly in the review so nobody claims a live-push verification happened that didn't.
2. Spec-compliance review against `.project/specs/git-tag-on-build-and-push.md` (tag source = HEAD, idempotency, no auto-push, warning wording, no src/ changes).
3. `npm test` final green.
4. Archive per the established convention: copy spec + plan into `.project/done/git-tag-on-build-push/{spec,plan}/` (sha-verify copies BEFORE `git rm` on originals), commit `docs: archive completed v2.1.1 spec+plan to .project/done/git-tag-on-build-push`.
5. Merge/finish per superpowers:finishing-a-development-branch (operator merges; the version tag gets created by the FIRST post-merge run of `./build-and-push.sh`, or manually via `git tag 2.1.1` from the right commit).
