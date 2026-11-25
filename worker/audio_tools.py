"""Audio helpers for the auto-cut module: measuring pauses and cutting audio.

Only needs numpy and ffmpeg (no WhisperX), so it can be tested on its own:
    python -m unittest test_audio_tools.py

All times are in seconds on the timeline of the original recording.
"""
import json
import subprocess

import numpy as np

FRAME = 0.02        # analysis frame for loudness (20 ms)
SNAP_FRAME = 0.005  # finer frame for finding the quietest point (5 ms)


# ---------------------------------------------------------------- loading / saving

def probe(path):
    """Sample rate and number of channels of an audio file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels",
         "-of", "json", path], check=True, capture_output=True).stdout
    s = json.loads(out)["streams"][0]
    return int(s["sample_rate"]), int(s["channels"])


def load_pcm(path, rate=None, channels=None):
    """Decodes a file to 16-bit samples, shape (samples, channels). Returns (data, rate)."""
    if rate is None or channels is None:
        r, c = probe(path)
        rate, channels = rate or r, channels or c
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-f", "s16le", "-acodec", "pcm_s16le",
         "-ar", str(rate), "-ac", str(channels), "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).reshape(-1, channels), rate


def to_mono_float(data):
    """(samples, channels) int16 → mono float32 in [-1, 1]."""
    x = data.astype(np.float32) / 32768.0
    return x.mean(axis=1) if x.ndim == 2 else x


# ---------------------------------------------------------------- measuring pauses

def frame_db(mono, rate, frame=FRAME):
    """Loudness per frame in dBFS."""
    n = max(1, int(rate * frame))
    usable = len(mono) - len(mono) % n
    if usable <= 0:
        return np.array([-120.0])
    x = mono[:usable].reshape(-1, n)
    rms = np.sqrt(np.mean(x.astype(np.float64) ** 2, axis=1))
    return 20 * np.log10(rms + 1e-10)


def _frames(db, a, b, frame=FRAME):
    """Frames lying completely within [a, b]."""
    i0, i1 = int(np.ceil(a / frame)), int(np.floor(b / frame))
    return db[max(0, i0):max(0, min(len(db), i1))]


def measure_gaps(mono, rate, words, min_gap=0.3, margin=0.03):
    """Measures the loudness between words.

    words: list of dicts with "s" and "e" (seconds). Returns
      {"gaps": [{"start", "end", "quiet", "db"}], "speechDb", "floorDb", "thresholdDb"}
    A gap counts as quiet when its loud parts (90th percentile) stay well below speech level.
    Music, laughter or noise between words are therefore "not quiet" and won't be shortened.
    """
    db = frame_db(mono, rate)
    timed = [w for w in words if w.get("s") is not None and w.get("e") is not None]
    speech_frames = [_frames(db, w["s"], w["e"]) for w in timed]
    speech_frames = [f for f in speech_frames if len(f)]
    speech = float(np.median(np.concatenate(speech_frames))) if speech_frames else float(np.median(db))
    floor = float(np.percentile(db, 10))
    threshold = min(speech - 12, max(speech - 25, floor + 6))

    gaps = []
    for a, b in zip(timed, timed[1:]):
        start, end = a["e"], b["s"]
        if end - start < min_gap:
            continue
        seg = _frames(db, start + margin, end - margin)
        if not len(seg):
            continue
        level = float(np.percentile(seg, 90))
        gaps.append({"start": round(start, 3), "end": round(end, 3), "quiet": bool(level < threshold), "db": round(level, 1)})
    return {"gaps": gaps, "speechDb": round(speech, 1), "floorDb": round(floor, 1), "thresholdDb": round(threshold, 1)}


# ---------------------------------------------------------------- cutting

def _pair(r):
    """A range as [start, end]; the app sends {"start", "end"}, tests use pairs."""
    return (float(r["start"]), float(r["end"])) if isinstance(r, dict) else (float(r[0]), float(r[1]))


def merge_ranges(ranges):
    out = []
    for s, e in sorted(p for p in map(_pair, ranges) if p[1] - p[0] > 0.001):
        if out and s <= out[-1][1] + 0.001:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def quietest_point(mono, rate, t, lo, hi, frame=SNAP_FRAME):
    """`mono` may also be (samples, channels) int16 data. The centre of the quietest short frame within [lo, hi] (seconds); ties go to the point nearest t."""
    lo, hi = max(0.0, lo), min(len(mono) / rate, hi)
    n = max(1, int(rate * frame))
    a, b = int(lo * rate), int(hi * rate)
    if b - a < n:
        return t
    x = mono[a:b]
    if x.ndim == 2:  # (samples, channels) int16: mix down only this short window
        x = x.astype(np.float32).mean(axis=1)
    usable = len(x) - len(x) % n
    energy = np.mean(x[:usable].reshape(-1, n).astype(np.float64) ** 2, axis=1)
    centres = (a + np.arange(len(energy)) * n + n / 2) / rate
    best = energy.min()
    # Everything within 1 dB of the quietest frame counts as equally quiet; take the one nearest t
    candidates = np.where(energy <= best * 1.26 + 1e-12)[0]
    k = candidates[np.argmin(np.abs(centres[candidates] - t))]
    return float(centres[k])


def snap_ranges(mono, rate, ranges, window=0.08, min_len=0.02):
    """Moves each cut boundary to the quietest point nearby (timestamps for "äh" are often a little off)."""
    out = []
    for s, e in merge_ranges(ranges):
        ns = quietest_point(mono, rate, s, s - window, min(s + window, e - min_len))
        ne = quietest_point(mono, rate, e, max(e - window, ns + min_len), e + window)
        if out and ns < out[-1][1]:  # never overlap the previous cut
            ns = out[-1][1]
        if ne - ns >= min_len:
            out.append([round(ns, 4), round(ne, 4)])
    return merge_ranges(out)


def render_chunks(data, rate, ranges, fade=0.02):
    """Yields the audio with the ranges removed, as int16 chunks.

    Every joint gets a short equal-power crossfade centred on the cut points, so there are no clicks
    and the removed length is exactly end − start. Pauses keep their own room sound.
    """
    n = len(data)
    half = int(rate * fade / 2)
    cuts = [(int(round(s * rate)), int(round(e * rate))) for s, e in merge_ranges(ranges)]
    pos = 0
    for cs, ce in cuts:
        cs, ce = max(pos, min(cs, n)), min(ce, n)
        if ce <= cs:
            continue
        h = max(0, min(half, cs - pos, n - ce))
        if cs - h > pos:
            yield data[pos:cs - h]
        if h:
            t = (np.arange(2 * h, dtype=np.float32) + 0.5) / (2 * h)
            fo = np.cos(t * np.pi / 2)[:, None]
            fi = np.sin(t * np.pi / 2)[:, None]
            a = data[cs - h:cs + h].astype(np.float32)
            b = data[ce - h:ce + h].astype(np.float32)
            yield np.clip(a * fo + b * fi, -32768, 32767).astype(np.int16)
        pos = ce + h
    if pos < n:
        yield data[pos:]


def render(data, rate, ranges, out_path, fade=0.02, codec="flac"):
    """Writes the cut audio to out_path (default FLAC, lossless). Returns its duration in seconds."""
    channels = data.shape[1]
    p = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(rate), "-ac", str(channels),
         "-i", "-", "-c:a", codec, out_path], stdin=subprocess.PIPE)
    total = 0
    try:
        for chunk in render_chunks(data, rate, ranges, fade):
            total += len(chunk)
            p.stdin.write(np.ascontiguousarray(chunk).tobytes())
    finally:
        p.stdin.close()
        if p.wait() != 0:
            raise RuntimeError("ffmpeg could not write the cut audio")
    return total / rate


def to_mp3(src, out_path):
    """Mono speech, 128 kbit/s, 44.1 kHz – the same settings as the app uses."""
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "44100",
                    "-codec:a", "libmp3lame", "-b:a", "128k", out_path], check=True)
