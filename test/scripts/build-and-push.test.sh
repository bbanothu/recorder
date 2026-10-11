#!/usr/bin/env bash
# build-and-push.test.sh — behavioral harness for the git-tag step of
# build-and-push.sh (spec: .project/specs/git-tag-on-build-and-push.md).
#
# Runs the CURRENT-WORKING-TREE build-and-push.sh inside throwaway git
# clones with a stub `docker` on PATH (exits 0 for any args), so no real
# build/push happens. Four cases (A: tag created, B: already tagged at
# HEAD, C: explicit version arg, D: tag pointing elsewhere).
#
# Exits non-zero on the FIRST failing assertion with 'FAIL <case>: <msg>'
# plus the captured script stdout for debugging; prints PASS per case.
#
# Intentionally RED until the tagging step is implemented in
# build-and-push.sh (Task 3).

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_UNDER_TEST="$REPO_ROOT/build-and-push.sh"

if [ ! -f "$SCRIPT_UNDER_TEST" ]; then
  echo "FAIL harness: build-and-push.sh not found at $SCRIPT_UNDER_TEST" >&2
  exit 1
fi

# ---------------------------------------------------------------- cleanup
TRACKED_DIRS=""
TRACKED_FILES=""
cleanup() {
  [ -n "$TRACKED_DIRS" ] && rm -rf $TRACKED_DIRS
  [ -n "$TRACKED_FILES" ] && rm -f $TRACKED_FILES
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers
CURRENT_CASE=""
CAPTURED_OUT=""

fail() {
  echo "FAIL ${CURRENT_CASE}: $1" >&2
  if [ -n "$CAPTURED_OUT" ] && [ -f "$CAPTURED_OUT" ]; then
    echo "---- captured stdout/stderr of build-and-push.sh ----" >&2
    cat "$CAPTURED_OUT" >&2
    echo "---- end captured output ----" >&2
  fi
  exit 1
}

assert_eq() { # desc expected actual
  [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"
}

assert_contains() { # desc needle file
  grep -qF -- "$2" "$3" || fail "$1: expected output to contain '$2'"
}

assert_not_contains() { # desc needle file
  ! grep -qF -- "$2" "$3" || fail "$1: expected output NOT to contain '$2'"
}

# make_clone <version> — fresh git repo with fixture package.json at <version>,
# one commit, plus a copy of the real build-and-push.sh. Sets CLONE (MSYS path,
# for file ops), CLONE_W (native Windows path — native git.exe mis-resolves
# POSIX /tmp or /c/... forms here, so every git call goes through g() with it),
# and STUB_BIN.
g() { # git wrapper: runs native git against the current clone (native paths)
  git -C "$CLONE_W" "$@"
}

make_clone() {
  local version="$1"
  local dir
  dir="$(mktemp -d)" || fail "$CURRENT_CASE: mktemp -d failed"
  TRACKED_DIRS="$TRACKED_DIRS $dir"
  CLONE="$dir/clone"
  CLONE_W="$(cygpath -w "$CLONE")"

  mkdir -p "$CLONE" "$dir/stubbin"
  STUB_BIN="$dir/stubbin"

  # Stub docker: accepts ANY args, always succeeds (inspect output empty —
  # the real script tolerates that with its 2>/dev/null || true guard).
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/docker"
  chmod 755 "$STUB_BIN/docker"

  g init -q "$CLONE_W"
  g config user.name "harness"
  g config user.email "harness@example.invalid"
  g config core.autocrlf false

  printf '{ "name": "fixture-repo", "version": "%s" }\n' "$version" > "$CLONE/package.json"
  echo "fixture" > "$CLONE/README.md"
  # The harness tests the current working-tree script; do not modify it here.
  cp "$SCRIPT_UNDER_TEST" "$CLONE/build-and-push.sh"
  chmod +x "$CLONE/build-and-push.sh"

  g add -A
  g commit -qm "release ${version}"
  # Sanity: the fixture commit must exist or later assertions are meaningless.
  g rev-parse HEAD >/dev/null 2>&1 || fail "$CURRENT_CASE: fixture commit failed in $CLONE_W"
}

# run_script [args...] — executes the cloned build-and-push.sh with stubbed
# docker on PATH; sets RC and CAPTURED_OUT.
run_script() {
  CAPTURED_OUT="$(mktemp)" || fail "$CURRENT_CASE: mktemp failed"
  TRACKED_FILES="$TRACKED_FILES $CAPTURED_OUT"
  PATH="$STUB_BIN:$PATH" bash "$CLONE/build-and-push.sh" "$@" >"$CAPTURED_OUT" 2>&1
  RC=$?
}

# =====================================================================
# Case A: default version from package.json -> tag created on HEAD
# =====================================================================
CURRENT_CASE="case A"
make_clone "2.1.1"
HEAD_SHA="$(g rev-parse HEAD)"
SHORT_SHA="$(g rev-parse --short HEAD)"
run_script
assert_eq "exit code should be 0" "0" "$RC"
if ! g tag -l | grep -qx "2.1.1"; then
  fail "expected tag 2.1.1 to exist, not found (git tag -l: [$(g tag -l | tr '\n' ' ')])"
fi
if g tag -l | grep -qx "v2.1.1"; then
  fail "tag must be plain semver '2.1.1', not 'v2.1.1'"
fi
assert_eq "tag 2.1.1 should point at HEAD" "$HEAD_SHA" "$(g rev-list -n1 2.1.1)"
assert_contains "tagged-HEAD output line" "==> Tagged HEAD (${SHORT_SHA}) as 2.1.1" "$CAPTURED_OUT"
assert_contains "manual push hint line" "git push origin 2.1.1" "$CAPTURED_OUT"
echo "PASS ${CURRENT_CASE} (tag created on HEAD)"

# =====================================================================
# Case B: version already tagged at HEAD -> warn, no overwrite, exit 0
# =====================================================================
CURRENT_CASE="case B"
make_clone "2.1.1"
HEAD_SHA="$(g rev-parse HEAD)"
g tag "2.1.1"
run_script
assert_eq "exit code should stay 0 on re-run" "0" "$RC"
assert_contains "already-exists warning" "already exists" "$CAPTURED_OUT"
assert_contains "leaving-it-alone wording" "leaving it alone" "$CAPTURED_OUT"
assert_not_contains "no overwrite/tagged line" "==> Tagged HEAD" "$CAPTURED_OUT"
assert_eq "pre-existing tag must not move" "$HEAD_SHA" "$(g rev-parse refs/tags/2.1.1)"
echo "PASS ${CURRENT_CASE} (already tagged at HEAD, left alone)"

# =====================================================================
# Case C: explicit version argument -> that version gets tagged
# =====================================================================
CURRENT_CASE="case C"
make_clone "2.1.1"
HEAD_SHA="$(g rev-parse HEAD)"
SHORT_SHA="$(g rev-parse --short HEAD)"
run_script "9.9.9"
assert_eq "exit code should be 0" "0" "$RC"
if ! g tag -l | grep -qx "9.9.9"; then
  fail "expected tag 9.9.9 to exist, not found (git tag -l: [$(g tag -l | tr '\n' ' ')])"
fi
assert_eq "tag 9.9.9 should point at HEAD" "$HEAD_SHA" "$(g rev-list -n1 9.9.9)"
assert_contains "tagged-HEAD output line" "==> Tagged HEAD (${SHORT_SHA}) as 9.9.9" "$CAPTURED_OUT"
assert_contains "manual push hint line" "git push origin 9.9.9" "$CAPTURED_OUT"
echo "PASS ${CURRENT_CASE} (explicit 9.9.9 arg tagged)"

# =====================================================================
# Case D: tag exists on a DIFFERENT commit -> warn, never move the tag
# =====================================================================
CURRENT_CASE="case D"
make_clone "2.1.1"
g tag "2.1.1"                        # points at first commit
TAGGED_SHA="$(g rev-parse refs/tags/2.1.1)"
echo "post-release change" > "$CLONE/notes.md"   # second commit moves HEAD
g add -A
g commit -qm "follow-up commit"
NEW_HEAD_SHA="$(g rev-parse HEAD)"
[ "$TAGGED_SHA" != "$NEW_HEAD_SHA" ] || fail "fixture broken: tag and HEAD are the same commit"
run_script
assert_eq "exit code should stay 0 (tag refusal must not fail the push)" "0" "$RC"
assert_contains "already-exists warning" "already exists" "$CAPTURED_OUT"
assert_contains "leaving-it-alone wording" "leaving it alone" "$CAPTURED_OUT"
assert_eq "tag must NOT be moved to HEAD" "$TAGGED_SHA" "$(g rev-parse refs/tags/2.1.1)"
echo "PASS ${CURRENT_CASE} (tag on other commit left untouched)"

echo "All 4 cases passed."
