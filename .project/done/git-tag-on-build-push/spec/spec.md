# Design: Git tag on build-and-push.sh (v2.1.1)

Status: **Approved** (user decisions 2026-09-21)

## Goal

Running `./build-and-push.sh` also tags the current git branch head (`HEAD`)
with the version number it just built and pushed, so every Docker image
version is 1:1 traceable to a git commit without a manual `git tag` step.

## Users / actors

- Operator: runs `./build-and-push.sh` after a release commit; gets a git tag
  created automatically alongside the Docker push.
- Remote server / future archaeology: `git tag` lists versions that exactly
  match the Docker Hub image tags (`pdebiss/discord-meeting-recorder:2.1.0` ←
  git tag `2.1.0`).

## Key decisions (user-approved)

1. **Patch release 2.1.1** (tooling/script-only change; AGENTS.md patch
   bump: "no API/env surface change"). Scope = `build-and-push.sh` +
   `package.json` version + `CHANGELOG.md` entry. No `src/` changes.
2. **Tag source: current branch HEAD** at the moment the script runs
   (user's wording: "tag the git branch with the version number"). Not
   "milestone commit hunting": keep it deliberately simple — whatever HEAD
   the script runs against gets the tag.
3. **Tag name = the resolved VERSION** (the same string that gets pushed to
   Docker Hub: package.json's version by default, or `$1` when explicitly
   given). One source of truth, so image tag and git tag never diverge.
4. **Local tag only; operator pushes manually later** (user chose this over
   auto-push). The script prints the exact `git push origin <tag>` command
   as a next-step hint after tagging so this is one copy-paste, not a memory
   exercise.
5. **Dry-run sanity in the script, not a format check**: idempotency comes
   free — `git tag` is a no-op failure (exit 1, loud) if the tag already
   exists pointing elsewhere; the script surfaces that error rather than
   silently re-tagging. No over-engineering on pre-validation beyond what
   git already gives us.

## Behavior spec

In `build-and-push.sh`, after the successful `docker push` of both tags:

```bash
# Tag the current branch HEAD with the version for image ↔ commit traceability.
if git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null 2>&1; then
  echo "==> Git tag ${VERSION} already exists — leaving it alone (no overwrite)."
else
  git tag "${VERSION}"
  echo "==> Tagged HEAD ($(git rev-parse --short HEAD)) as ${VERSION}"
fi
echo "    Push the tag to the remote when ready:  git push origin ${VERSION}"
```

- Idempotent: re-running the script for the same version does not fail the
  whole push flow on the tag step — it warns and moves on (the tag already
  pointing at the right HEAD is the common re-run case; if it points
  elsewhere, that's an operator decision the warning surfaces, not an error
  the script should crash on mid-deploy).

## Data model

None (script-only).

## Out of scope

- Pushing the tag automatically (user declined; manual `git push origin <tag>`).
- Tag patterns other than plain semver (`v`-prefixed, annotated, signed).
- CI/CD wiring — this repo has none today.
- Retagging / moving an existing tag to a different commit (deliberately not
  supported — that erases history).

## Acceptance criteria

1. `./build-and-push.sh` on a branch with `package.json` version 2.1.1
   creates a git tag `2.1.1` pointing at current `HEAD`, after a successful
   docker push of `pdebiss/discord-meeting-recorder:2.1.1` + `:latest`.
2. Re-running the same script (same version already tagged) does NOT fail —
   prints "already exists — leaving it alone" and continues/exits 0.
3. Explicit version arg (`./build-and-push.sh 9.9.9`) tags `9.9.9` specifically
   (not package.json's).
4. `npm test` green; package.json `2.1.1`; CHANGELOG entry under
   `## [2.1.1] - <today>`; no src/ changes (git diff proves it).

## Risks / tradeoffs

- Tag names HEAD, whatever HEAD is: if the operator runs the script from a
  dirty/work-in-progress state, the tag lands on a non-release commit.
  Accepted (user explicitly picked HEAD; the script prints the short SHA
  next to the tag so it's visible in output).
- Local-only tags can be lost with the clone; mitigated by the printed
  `git push origin <tag>` hint and the fact that the tag's purpose (commit
  ↔ image traceability) is recoverable from Docker Hub digests.
- Tag collision (same version, different commit): git refuses; script warns
  and continues — operator inspects manually. Chosen over auto-force-replace.
