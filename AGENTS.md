# AGENTS.md

Instructions for AI agents (and humans) working in this repository.

## Project

Discord per-user voice meeting recorder (`/record`, `/stop`). Node.js ≥ 22 ESM,
discord.js v14 + @discordjs/voice + @snazzah/davey, no build step, no framework.
Tests: `node --test` (files in `test/*.test.mjs`). Run: `npm start` or Docker.

## Release pattern (REQUIRED on every user-visible change)

1. **Bump `"version"` in `package.json`** following semver:
   - patch `x.y.Z` — fixes, tuning, no API/env surface change
   - minor `x.Y.0` — new feature, new env var, backward compatible
   - major `X.0.0` — breaking change (e.g. env var rename/removal, behavior change for existing configs)
2. **Add/extend a CHANGELOG.md entry** under a new `## [x.y.z] - YYYY-MM-DD`
   heading (Keep a Changelog format: `### Added` / `### Changed` / `### Fixed` /
   `### Removed`). The heading must match the package.json version exactly.
3. Commit code + docs + version together in the feature/release commit.
4. Build & publish: `./build-and-push.sh` tags and pushes the Docker image using
   the package.json version (`pdebiss/discord-meeting-recorder:<version>` +
   `:latest`). Never hand-push `:latest` without bumping the version first.
   The script also creates a local git tag `<version>` on HEAD — push it
   explicitly alongside the release (`git push origin <version>`); skipping
   that push is the only way git and Docker Hub drift apart.

Docs that must be touched alongside the version bump when relevant:
- `.env.example` — any new/changed env var (with comment; keep keys in sync with `src/env.js`)
- `README.md` — user-facing behavior/modes
- `SETUP.md` — requirements, env table, run instructions

## Code conventions

- **TDD**: failing test first (RED), minimal implementation (GREEN), then refactor.
  All tests must pass (`npm test`) before committing.
- Dependency injection style for anything time/timer/IO-related: pass
  `now`, `setTimeout`/`setInterval`, `encodeToOgg`, etc. as `deps`/`opts` so
  tests never sleep or shell out to ffmpeg.
- Pure decision logic goes in its own module (see `src/auto-stop.js` pattern in
  plans/) — keep `bot.js` glue thin.
- Slash-command registration must never crash the gateway: per-guild try/catch
  is intentional (see `src/index.js`). A dead process loses live recordings.
- Env validation at load time (`src/env.js`), loud errors, no silent defaults
  for required vars. Values that reach shell tools (ffmpeg args) are
  pattern-validated.
- Audio pipeline truth: master mix = 20 ms grid → WAV → ffmpeg libopus
  **mono, `-application voip`, `-b:a MASTER_BITRATE` (default 24k)**. Do not
  re-add stereo or generic-audio mode "for quality" — it triples file size;
  Discord's 25 MB upload cap is the constraint.

## Git

- Conventional commits (`feat:` / `fix:` / `chore:` / `docs:`), imperative summary.
- Commit per logical change, not per file edit.
- Do not commit `.env` or anything in `discord-meetings/` (already gitignored);
  verify with `git status` before `git add -A`.

## Testing checklist before "done"

- [ ] `npm test` green
- [ ] Feature-relevant docs updated (see Docs list above)
- [ ] package.json version + CHANGELOG heading bumped in the same commit
- [ ] For audio changes: measure output size (encode a known-length WAV with the
      real `buildFfmpegArgs` output) — don't hand back estimates
