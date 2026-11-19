"""Hallraum transcription worker.

Runs on a separate computer (directly with Python or in Docker). Polls the app for jobs,
downloads the audio, transcribes it with WhisperX (word-level timestamps, speaker
detection) and sends the result back. Needs no open ports; the app never depends on it.

Environment variables:
  APP_URL          e.g. https://podcast.example.org (local: http://localhost:3000)
  WORKER_TOKEN     shared secret (same as in the app)
  HF_TOKEN         Hugging Face token for speaker detection (optional; without: no speakers)
  WHISPER_MODEL    default large-v3-turbo (faster); more accurate: large-v3
  POLL_SECONDS     polling interval, default 30
  THREADS          CPU threads, default: all
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import urllib.error

APP_URL = os.environ.get("APP_URL", "http://localhost:3000").rstrip("/")
TOKEN = os.environ.get("WORKER_TOKEN", "")
HF_TOKEN = os.environ.get("HF_TOKEN") or None
MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
POLL = int(os.environ.get("POLL_SECONDS", "30"))
THREADS = int(os.environ.get("THREADS", str(os.cpu_count() or 4)))
DEVICE = "cpu"  # WhisperX only uses the CPU on a Mac (and in Docker)
INFO = f"{socket.gethostname()} · {MODEL}"

# Initial prompts that encourage verbatim transcripts including filler words
# (the basis for filler detection and the planned auto-cut module). One per language.
PROMPTS = {
    "de": "Ähm, also, äh, ich mein, hm, ja. Also das ist, äh, wirklich so.",
    "en": "Um, so, uh, I mean, hmm, yeah. Like, uh, it's really, um, like that.",
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def call(method, path, body=None, raw=None, content_type="application/json", timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(APP_URL + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def download(path, target):
    req = urllib.request.Request(APP_URL + path, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=600) as r, open(target, "wb") as f:
        shutil.copyfileobj(r, f, 1024 * 1024)


class Progress:
    """Reports progress regularly (keeps the job "alive" in the app).
    Progress is sent as codes (e.g. "aligning") or percentages; the app translates them."""

    def __init__(self, job_id):
        self.job_id = job_id
        self.text = "starting"
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def set(self, text):
        self.text = text
        log(f"Job {self.job_id}: {text}")
        self._send()

    def _send(self):
        try:
            call("POST", f"/api/worker/jobs/{self.job_id}/progress", {"progress": self.text, "info": INFO})
        except Exception as e:  # progress is not critical
            log("Could not report progress:", e)

    def _run(self):
        while not self._stop.wait(60):
            self._send()

    def stop(self):
        self._stop.set()


_models = {}


def whisper_model(language):
    import whisperx

    key = language or "auto"
    if key not in _models:
        log(f"Loading Whisper model {MODEL} ({key}) …")
        _models.clear()  # keep only one model in memory
        _models[key] = whisperx.load_model(
            MODEL, DEVICE, compute_type="int8", language=language, threads=THREADS,
            asr_options={"initial_prompt": PROMPTS.get(language) if language else None, "suppress_numerals": False},
        )
    return _models[key]


def transcribe(job, path, progress):
    import whisperx

    opts = job.get("options") or {}
    language = opts.get("language") or None
    progress.set("loading")
    audio = whisperx.load_audio(path)
    duration = len(audio) / 16000.0

    if not language:
        progress.set("detecting-language")
        model = whisper_model(None)
        language = model.detect_language(audio)
        log("Detected language:", language)

    model = whisper_model(language)
    last = [0.0]

    def on_progress(pct):
        if pct - last[0] >= 5:
            last[0] = pct
            progress.set(f"{int(pct)} %")

    progress.set("0 %")
    result = model.transcribe(audio, batch_size=8, language=language, progress_callback=on_progress)

    progress.set("aligning")
    align_model, meta = whisperx.load_align_model(language_code=language, device=DEVICE)
    result = whisperx.align(result["segments"], align_model, meta, audio, DEVICE, return_char_alignments=False)
    del align_model

    if HF_TOKEN:
        progress.set("diarizing")
        from whisperx.diarize import DiarizationPipeline

        diar = DiarizationPipeline(token=HF_TOKEN, device=DEVICE)
        segments = diar(audio, min_speakers=1, max_speakers=int(opts.get("maxSpeakers") or 4))
        result = whisperx.assign_word_speakers(segments, result, fill_nearest=True)
    else:
        log("No HF_TOKEN – skipping speaker detection.")

    words = []
    for seg in result["segments"]:
        for w in seg.get("words", []):
            text = (w.get("word") or "").strip()
            if not text:
                continue
            words.append({
                "w": text,
                "s": round(w["start"], 3) if "start" in w else None,
                "e": round(w["end"], 3) if "end" in w else None,
                "sp": w.get("speaker") or seg.get("speaker") or "SPEAKER_00",
                "c": round(w["score"], 2) if "score" in w else None,
            })
    return {"language": language, "duration": duration, "words": words}


def make_mp3(src, job_id):
    out = src + ".mp3"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "44100",
                    "-codec:a", "libmp3lame", "-b:a", "128k", out], check=True)
    with open(out, "rb") as f:
        call("POST", f"/api/worker/jobs/{job_id}/mp3", raw=f.read(), content_type="audio/mpeg", timeout=600)


def handle(job):
    job_id = job["id"]
    progress = Progress(job_id)
    tmp = tempfile.mkdtemp(prefix="job-")
    try:
        progress.set("downloading")
        ext = os.path.splitext(job["audio"].get("name") or "")[1] or ".audio"
        path = os.path.join(tmp, "input" + ext)
        download(job["audio"]["url"], path)
        if (job.get("options") or {}).get("needsMp3"):
            progress.set("mp3")
            make_mp3(path, job_id)
        if job["type"] != "transcribe":
            raise RuntimeError(f"job type {job['type']} is not supported yet")
        result = transcribe(job, path, progress)
        progress.set("sending")
        result["info"] = INFO
        call("POST", f"/api/worker/jobs/{job_id}/result", result, timeout=300)
        log(f"Job {job_id} done: {len(result['words'])} words.")
    except Exception as e:
        traceback.print_exc()
        try:
            call("POST", f"/api/worker/jobs/{job_id}/fail", {"error": f"{type(e).__name__}: {e}"})
        except Exception as e2:
            log("Could not report the error:", e2)
    finally:
        progress.stop()
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if len(TOKEN) < 16:
        sys.exit("WORKER_TOKEN is missing or too short (at least 16 characters).")
    log(f"Hallraum worker starting: {APP_URL}, model {MODEL}, speaker detection {'on' if HF_TOKEN else 'off'}")
    while True:
        try:
            r = call("POST", "/api/worker/next", {"types": ["transcribe"], "info": INFO})
            job = r.get("job")
            if job:
                log(f"New job {job['id']} (episode {job['episodeId']})")
                handle(job)
                continue  # ask for the next one right away
        except urllib.error.HTTPError as e:
            log(f"App answered {e.code}: {e.read()[:200]!r}")
        except Exception as e:
            log("App not reachable:", e)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
