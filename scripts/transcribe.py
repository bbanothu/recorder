"""faster-whisper sidecar: --input FILE --model NAME [--cache-dir DIR] [--translate] -> NDJSON {segments, language} on stdout.
--translate uses Whisper's own translate task (to English), not transcribe — the model does this directly from audio, not as a text post-process."""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--cache-dir")
    ap.add_argument("--translate", action="store_true")
    a = ap.parse_args()
    if a.cache_dir:
        os.environ.setdefault("HF_HOME", a.cache_dir)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write("faster_whisper not installed\n"); sys.exit(3)
    compute = "cuda" if _cuda_ok() else "cpu"
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS", "4"))
    model = WhisperModel(a.model, device=compute, compute_type="int8", cpu_threads=cpu_threads)
    task = "translate" if a.translate else "transcribe"
    segs, info = model.transcribe(a.input, vad_filter=True, beam_size=5, task=task)
    out = {"language": info.language, "segments": [
        {"start": s.start, "end": s.end, "text": s.text} for s in segs
    ]}
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")

def _cuda_ok():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False

main()
