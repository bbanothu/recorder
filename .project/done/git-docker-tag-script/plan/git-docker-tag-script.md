# Git-Docker-Tag Backfill Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-time sync of git tags with every version published to Docker Hub, so each historical release commit carries its exact `package.json` / Docker Hub version tag.

**Architecture:** `build-and-push.sh` already creates a **local git tag named exactly `<version>`** (no `v` prefix, e.g. `2.1.1`) on HEAD after a successful push — never pushed, never overwritten. Only `2.1.1` exists today. A throwaway backfill script walks each released version, finds the commit where `package.json` carried that version, and applies the bare-version tag. After one run, the script is deleted. The only repo file change is one `docs:` commit carrying the audit table.

**Tech Stack:** bash, `git log -S` / `git tag`, `node -p` for reading `package.json` (the repo's own idiom in build-and-push.sh — no `jq`).

---

## Ground truth (verified 2026-09-22 against live git + Docker Hub API)

- Repo: `C:\Users\wot38\Documents\GitHub\discord-meeting-recorder`
- Current `package.json` version: `2.1.1`; existing git tags: **only `2.1.1`**
- **Actual version set ever in `package.json`** (13 versions — there is no 1.3.0):
  `1.0.0, 1.1.0, 1.2.0, 1.4.0, 1.5.0, 1.5.1, 1.5.2, 1.5.3, 1.6.0, 1.7.0, 2.0.0, 2.1.0, 2.1.1`
- Bump commits (from `git log -- package.json` reading the version at each commit):

  | Version | Commit | Subject |
  |---|---|---|
  | 1.0.0 | f1b41fa | feat: SINGLE_FILE master-only mode… (also 9be3513, 6881603 — see convention note) |
  | 1.1.0 | bfdab3e | chore(release): 1.1.0 auto-stop failsafe docs |
  | 1.2.0 | a15c6fd | feat(bot): public recording lifecycle announcements |
  | 1.4.0 | a3f388f | chore(release): 1.4.0 runtime-togglable single-file mode |
  | 1.5.0 | 5f49a73 | chore(release): 1.5.0 combined auto-stop + single-file runtime config |
  | 1.5.1 | f4051bd | chore(release): 1.5.1 auto-register slash commands |
  | 1.5.2 | 127077f | chore(release): 1.5.2 re-register commands on guild rejoin |
  | 1.5.3 | c929921 | feat(log): include app version in startup log line |
  | 1.6.0 | 94d04d9 | chore(release): 1.6.0 master-mix transcription |
  | 1.7.0 | 83e2fed | chore(release): 1.7.0 speaker-attributed meeting transcripts |
  | 2.0.0 | 4cfb08c | chore: release 2.0.0 |
  | 2.1.0 | 69c741c | chore: release 2.1.0 (dbccae1 carries the same version — pick the release commit) |
  | 2.1.1 | c152082 | chore: release 2.1.1 (already tagged — skip) |

- **Docker Hub tags (live API 2026-09-22):** `1.0.0, 1.2.0, 1.4.0, 1.5.0, 1.5.2, 1.5.3, 1.6.0, 1.7.0, 2.0.0, 2.1.0, 2.1.1, latest`
- **In git but NOT on Hub — investigate, do not tag: `1.1.0`, `1.5.1`.** (The reviewer's feedback also listed 1.4.0 here; the live API call above disproves that — `1.4.0` is present on Hub.)
- Tag convention (from `build-and-push.sh`): bare semver, lightweight, local-only, no overwrite → backfill must match exactly.

## Anchor convention (state explicitly in the audit record)

- Rule: tag the **newest** commit at each version that is **below the next bump** (i.e. the commit where that version lives in `package.json` immediately before it changed again). This resolves multi-commit versions: `1.0.0` (three commits) → `f1b41fa`; `2.1.0` (`69c741c` vs `dbccae1`) → `69c741c`.
- Known approximations: **`1.2.0` → `a15c6fd`** and **`1.5.3` → `c929921`** are `feat:` commits where the version string first appears — the nearest anchor to what the pushed image actually contained. Accepted; mark them with `~` in the audit table.
- Consequently the dry-run gate must expect non-`chore:` subjects (1.0.0, 1.2.0, 1.5.3) — expected, not an anomaly.

## Deliverable

1. **`tag-backfill.sh`** — written to repo root for convenience (so relative paths and `git log -S` just work), run once, verified, then deleted. Never committed. No `scripts/` folder.
2. **One `docs:` commit** appending the three-way sync audit table to this plan file (Task 4) — the record lives with the repo.

## Tasks

### Task 1 — Confirm the target set (verification only, no writes)

- [ ] Re-run both enumerations to confirm the ground-truth table hasn't drifted:
  ```bash
  git log --format='%H' -- package.json | while read c; do \
    git show "$c:package.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null; \
  done | sort -uV
  curl -s "https://hub.docker.com/v2/repositories/pdebiss/discord-meeting-recorder/tags?page_size=100" \
    | node -p "JSON.parse(require('fs').readFileSync(0)).results.map(t=>t.name).join('\n')"
  ```
- [ ] Target set = git versions ∩ Hub version tags (minus `latest`). Expected from 2026-09-22 data: 11 versions; minus already-tagged `2.1.1` = **10 tags to create**.
- [ ] `1.1.0` and `1.5.1`: investigate why they never reached Hub (likely superseded before push). Record the finding in the audit table; **do not tag them**.

### Task 2 — Write `tag-backfill.sh` (repo root, throwaway)

- [ ] For each version `V` in the target set:
  1. Skip if `git rev-parse -q --verify "refs/tags/V"` succeeds (idempotent; matches build-and-push.sh's no-overwrite rule).
  2. Candidates: `git log --format='%H %s' -S"\"version\": \"V\"" -- package.json`
  3. **Confirm the pick**: the **newest** commit where `git show <sha>:package.json` actually has `"version": "V"` AND `<sha>` is not a descendant of the next-higher version's release commit (anchor rule above). The `-S` pickaxe matches additions *and* removals, so the previous release commit also surfaces — this confirmation is mandatory.
  4. `git tag V <sha>` (lightweight, bare name — consistent with build-and-push.sh).
- [ ] `--dry-run` flag: print `V → short-sha → commit subject` for every planned action, touch no tags.
- [ ] Embed the ground-truth table (Task 1 versions → expected shas) as a hard expectation list so the dry-run output can be diffed line-for-line against it.

### Task 3 — Dry-run review gate

- [ ] `bash tag-backfill.sh --dry-run` — every resolved sha must match the ground-truth table. `feat:`-subject anchors (1.0.0, 1.2.0, 1.5.3) are expected per the convention; anything else that diverges is a defect.
- [ ] Any ambiguous or unmatched version: resolve manually with `git log --oneline -- package.json`, fix the script, re-run until the diff against expectation is empty. Do not proceed on a guess.

### Task 4 — Execute + verify + audit record

- [ ] `bash tag-backfill.sh`
- [ ] Verify per tag: `git show <V>:package.json` contains `"version": "<V>"`.
- [ ] **Three-way sync report** — per tag, prove Docker Hub ↔ git tag ↔ release commit agree:
  ```bash
  for V in $(git tag --list | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V); do
    SHA=$(git rev-list -n1 "$V")
    PKG=$(git show "$V:package.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version")
    SUBJ=$(git log -1 --format='%h %s' "$SHA")
    HUB=$(curl -s -o /dev/null -w '%{http_code}' \
      "https://hub.docker.com/v2/repositories/pdebiss/discord-meeting-recorder/tags/${V}")
    printf '%-8s hub:%s pkg:%-8s %s\n' "$V" "$([ "$HUB" = 200 ] && echo ok || echo MISSING)" "$PKG" "$SUBJ"
  done
  ```
  Every row must read: `hub:ok`, `pkg` == tag name, subject is that version's anchor commit. Any mismatch → fix before pushing.
- [ ] Append the table to this plan file under `## Audit record`, marking approximations (`~` on 1.2.0, 1.5.3) and noting the 1.1.0 / 1.5.1 never-published finding with its cause.
- [ ] **Enumerated push — never `--tags`:**
  ```bash
  git push origin 1.0.0 1.2.0 1.4.0 1.5.0 1.5.2 1.5.3 1.6.0 1.7.0 2.0.0 2.1.0 2.1.1
  ```
  (build-and-push.sh deliberately never pushes tags — this is the moment history lands on the remote. Do not rely on pre-pruning to make `--tags` safe.)
- [ ] `rm tag-backfill.sh` (never staged, so plain delete).
- [ ] Commit the audit-record update as one `docs:` commit — the only file change in the repo.
- [ ] Verify: `git ls-remote --tags origin` matches local `git tag --list`; `git status` clean.

### Task 5 — Going forward (contract)

- [ ] `build-and-push.sh` covers every future release: run it → local `<version>` tag on HEAD → **push that tag explicitly** (`git push origin <version>`) alongside the release push. Skipping the tag push is the only way to drift again.
- [ ] Add that push-step line to AGENTS.md release pattern step 4 **in the same `docs:` commit** as the audit record. Per AGENTS.md conventions, agent-facing docs alone need no version bump; if the user judges the audit record user-facing, fold it into the next release's CHANGELOG instead.

## Acceptance Criteria

- [ ] Every version on Docker Hub (excluding `latest`) has an identically named git tag pointing at its anchor commit whose `package.json` held that version
- [ ] Three-way sync table shows `hub:ok`, `pkg == tag`, anchor-commit subject for every row
- [ ] Audit table committed in this plan file as one `docs:` commit (the sole repo file change, together with the AGENTS.md step-4 line)
- [ ] Tags pushed via **enumerated** `git push origin <v1> <v2> …` — no `--tags`
- [ ] `git ls-remote --tags origin` matches local `git tag --list`
- [ ] `2.1.1` untouched; no tag created twice; nothing overwritten
- [ ] No `tag-backfill.sh` left behind; working tree clean after the `docs:` commit
- [ ] `1.1.0` and `1.5.1` remain untagged with a recorded explanation

## Risks / Pitfalls

- **Pickaxe false positives**: `-S` matches the version string being removed as well as added; the confirm step in Task 2.3 is the guard.
- **Multi-commit versions**: `1.0.0` (three commits) and `2.1.0` (release + test commit share the version) need the newest-below-next-bump rule — the ground-truth table is the check.
- **Built-but-never-pushed versions**: `1.1.0`, `1.5.1` are in git but not Hub today; a historically pushed-then-pruned version would also look never-published (Hub reflects current tags). Investigate, record, don't tag.
- **`git push --tags` blast radius**: banned — enumerated push only.
- **Approximation drift**: 1.2.0/1.5.3 anchors are `feat:` commits, best-effort matches to image contents; stated in the audit record so nobody later mistakes them for proven release commits.

## Audit record (executed 2026-09-22, SDD run; anchors corrected same day — see convention note)

Three-way sync: Docker Hub tag ↔ local git tag ↔ anchor commit. All 10 tags
lightweight (`git cat-file -t` → `commit`), bare-named, local-only.

**Final anchor convention (operator-decided, supersedes the newest-below-next-bump
rule above): tag the newest master commit BEFORE the image's Hub
`tag_last_pushed` timestamp — i.e. the HEAD `build-and-push.sh` would have built
from. Verified via `git rev-list -1 --before=<push+00:00> master`; every result's
package.json parses to its tag version.** Five tags (1.0.0, 1.2.0, 1.6.0, 2.0.0,
2.1.0) were moved accordingly (`git tag -d` + recreate; nothing ever pushed, so
zero blast radius); five already matched and were untouched.

| Version | Hub | pkg.json @ tag | Anchor | Subject |
|---|---|---|---|---|
| 1.0.0 | ok | 1.0.0 | aea2b80 | feat: master mix mono+voip opus with MASTER_BITRATE env (default 24k) |
| 1.2.0 | ok | 1.2.0 | d01e17a | fix(auto-stop): notice tail reflects actual DM delivery outcome |
| 1.5.0 | ok | 1.5.0 | 5f49a73 | chore(release): 1.5.0 combined auto-stop + single-file runtime config |
| 1.5.2 | ok | 1.5.2 | 127077f | chore(release): 1.5.2 re-register commands on guild rejoin |
| 1.5.3 | ok | 1.5.3 | c929921 | feat(log): include app version in startup log line |
| 1.6.0 | ok | 1.6.0 | e00fa66 | docs: transcription resource-safety notes (1.6.0) |
| 1.7.0 | ok | 1.7.0 | 83e2fed | chore(release): 1.7.0 speaker-attributed meeting transcripts |
| 2.0.0 | ok | 2.0.0 | 2bd2d10 | fix: dedupe store validation, catch login rejection, drop stale singleFile shim |
| 2.1.0 | ok | 2.1.0 | c795bd1 | docs: archive completed v2.1.0 spec+plan to .project/done/master-speaker-attribution |
| 2.1.1 | ok | 2.1.1 | dccdac3 | pre-existing tag from build-and-push.sh — untouched (SKIP path; note: points at the post-release docs commit, not c152082) |

- **1.0.0 anchor note**: three commits hold 1.0.0 (6881603, 9be3513, f1b41fa); newest-below-next-bump rule → f1b41fa (not in the Task-2 ground-truth table's scaffold row — corrected during execution). Superseded by the push-timestamp rule → aea2b80 (committed 2026-09-18 23:25:05 CDT, 28 s before the 1.0.0 push at 23:25:33 CDT; the morning-after docs commit 05fc4eb post-dates the push and cannot be the build source). Caveat: 28 s fits only a cached-layers re-push; Hub's API cannot disambiguate re-pushes, this is the best available evidence.
- **Never-published versions (git but not Hub, left untagged, investigated)**: `1.1.0` (bfdab3e) and `1.5.1` (f4051bd) — superseded before push: each was bumped past within the same day (1.2.0 landed 2026-09-19, 1.5.2 the same day), so no image was ever built for them. `1.3.0` exists only as release commit aaea7dc on a merged side branch (hidden from `git log -- package.json` simplification); never held on master's first-parent package.json walk — untagged.
- **Plan correction (live API beats stale table)**: line 37/38 claim of `1.4.0` being on Hub is wrong — direct tag probe returned 404 and the tag list (11 tags, no pagination) excludes it. `1.4.0` joins the never-published set (a3f388f untagged; superseded same day by 1.5.0). Target set executed as 9 created + 1 skipped.
- **Mechanism deviation**: `tag-backfill.sh` replaced the literal `-S` pickaxe candidate query with a pickaxe-free walk of `git log master -- package.json` + per-commit `node -p` version confirmation — a superset of pickaxe hits with the mandatory confirm built in (spec review PASS, deviation noted).
- **Push status**: repo has no `origin` remote; enumerated `git push origin <tags>` deferred by operator decision. When the remote exists: `git push origin 1.0.0 1.2.0 1.5.0 1.5.2 1.5.3 1.6.0 1.7.0 2.0.0 2.1.0 2.1.1` (never `--tags`).
- Script deleted after run; working tree carries no code changes beyond this docs commit + AGENTS.md step-4 line.
