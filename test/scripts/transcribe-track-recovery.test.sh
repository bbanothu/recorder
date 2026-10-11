#!/usr/bin/env bash
# transcribe-track-recovery.test.sh — D8 / AC10: a poison-first per-user track
# (undecodable packets at audio-packet indices 0 and 4) is canonicalised by the
# ffmpeg transcode the same way src/transcribe.js does it (buildTranscodeArgs).
# Skips LOUDLY (exit 0) when ffmpeg is missing; the PyAV step skips loudly
# when python3 + PyAV are missing.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POISON="$REPO_ROOT/test/fixtures/per-user-track-undecodable.ogg"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "SKIP transcribe-track-recovery: ffmpeg not found on PATH (the image has it)"
  exit 0
fi
[ -f "$POISON" ] || { echo "FAIL fixture missing: $POISON" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
WAV="$WORK/out.wav"

# (a) the raw track makes ffmpeg report a decode error
RAW_ERR="$(ffmpeg -v error -i "$POISON" -f null - 2>&1)"
echo "$RAW_ERR" | grep -Eq 'Error parsing the packet header|Invalid data found' \
  || { echo "FAIL (a): expected a decode error from the poison track, got: [$RAW_ERR]" >&2; exit 1; }
echo "PASS (a): poison track reports a decode error"

# (b) after the canonical transcode the WAV decodes cleanly
ffmpeg -y -v error -i "$POISON" -ar 16000 -ac 1 "$WAV" 2>/dev/null \
  || { echo "FAIL (b): transcode exited non-zero" >&2; exit 1; }
WAV_ERR="$(ffmpeg -v error -i "$WAV" -f null - 2>&1)"
[ -z "$WAV_ERR" ] || { echo "FAIL (b): WAV still has decode errors: [$WAV_ERR]" >&2; exit 1; }
echo "PASS (b): transcoded WAV decodes with no error"

# (c) PyAV: raw track yields ~0 samples, WAV yields the full duration
if command -v python3 >/dev/null 2>&1 && python3 -c "import av" >/dev/null 2>&1; then
  python3 - "$POISON" "$WAV" <<'PY' || { echo "FAIL (c): PyAV assertion" >&2; exit 1; }
import sys, av
def samples(path):
    n = 0
    try:
        with av.open(path) as c:
            for f in c.decode(audio=0):
                n += f.samples
    except Exception:
        pass
    return n
raw = samples(sys.argv[1]); wav = samples(sys.argv[2])
print(f"PyAV samples raw={raw} wav={wav}")
assert raw < 16000, f"raw track should decode ~0 samples, got {raw}"
assert wav > 16000 * 4.5, f"WAV should decode the full duration, got {wav}"
PY
  echo "PASS (c): PyAV raw ~0 samples, WAV full duration"
else
  echo "SKIP (c): python3 with PyAV (import av) not available on this host; (a) and (b) ran"
fi
echo "PASS transcribe-track-recovery"
