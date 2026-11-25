"""Tests for audio_tools.py (needs numpy and ffmpeg, not WhisperX).

Run from the worker folder:  python -m unittest test_audio_tools.py
"""
import os
import tempfile
import unittest

import numpy as np

import audio_tools as at

RATE = 16000


def signal(parts, rate=RATE, seed=1):
    """parts: list of (kind, seconds) with kind "word" (loud noise), "silence" (quiet room tone),
    "music" (a tone at moderate level). Returns int16 (samples, 1) and the word list."""
    rng = np.random.default_rng(seed)
    out, words, t = [], [], 0.0
    for kind, dur in parts:
        n = int(dur * rate)
        if kind == "word":
            x = rng.normal(0, 0.2, n)
            words.append({"s": round(t, 3), "e": round(t + dur, 3)})
        elif kind == "music":
            x = 0.05 * np.sin(2 * np.pi * 440 * np.arange(n) / rate) + rng.normal(0, 0.001, n)
        else:
            x = rng.normal(0, 0.001, n)
        out.append(x)
        t += dur
    x = np.concatenate(out)
    return (np.clip(x, -1, 1) * 32767).astype(np.int16).reshape(-1, 1), words


class MeasureGaps(unittest.TestCase):
    def test_quiet_pause_and_music(self):
        data, words = signal([("word", 0.5), ("silence", 1.5), ("word", 0.5), ("music", 2.0), ("word", 0.5), ("silence", 0.1), ("word", 0.4)])
        res = at.measure_gaps(at.to_mono_float(data), RATE, words)
        self.assertEqual([g["quiet"] for g in res["gaps"]], [True, False], "music between words is not quiet")
        self.assertEqual(len(res["gaps"]), 2, "gaps shorter than 0.3 s are not measured")
        self.assertAlmostEqual(res["gaps"][0]["start"], 0.5)
        self.assertAlmostEqual(res["gaps"][0]["end"], 2.0)
        self.assertLess(res["thresholdDb"], res["speechDb"])

    def test_words_without_times_are_skipped(self):
        data, words = signal([("word", 0.5), ("silence", 1.0), ("word", 0.5)])
        words.insert(1, {"s": None, "e": None})
        self.assertEqual(len(at.measure_gaps(at.to_mono_float(data), RATE, words)["gaps"]), 1)


class Cutting(unittest.TestCase):
    def test_removed_length_is_exact(self):
        data, _ = signal([("word", 1.0), ("silence", 2.0), ("word", 1.0)])
        chunks = list(at.render_chunks(data, RATE, [[1.2, 2.5], [0.4, 0.6]]))
        total = sum(len(c) for c in chunks)
        self.assertEqual(total, len(data) - int(1.3 * RATE) - int(0.2 * RATE))

    def test_ranges_as_sent_by_the_app(self):
        self.assertEqual(at.merge_ranges([{"start": 2, "end": 3}, [0.5, 1], {"start": 2.5, "end": 4}]), [[0.5, 1.0], [2.0, 4.0]])

    def test_crossfade_has_no_jump(self):
        # A constant tone cut in the middle: with a crossfade the joint has no large step
        n = 2 * RATE
        tone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(n) / RATE) * 32767).astype(np.int16).reshape(-1, 1)
        out = np.concatenate(list(at.render_chunks(tone, RATE, [[0.5003, 1.2007]])))[:, 0].astype(np.float64)
        steps = np.abs(np.diff(out))
        normal = np.abs(np.diff(tone[:, 0].astype(np.float64))).max()
        self.assertLess(steps.max(), normal * 2.5)

    def test_snapping_moves_to_silence(self):
        # Word 0–1 s, silence 1–1.5 s, word 1.5–2.5 s. A cut boundary placed 50 ms inside the
        # second word is pulled back into the silence.
        data, _ = signal([("word", 1.0), ("silence", 0.5), ("word", 1.0)])
        mono = at.to_mono_float(data)
        [[s, e]] = at.snap_ranges(mono, RATE, [[1.1, 1.55]])
        self.assertGreaterEqual(s, 1.0)
        self.assertLessEqual(e, 1.5)
        self.assertLess(e - s, 0.5)

    def test_render_and_mp3_with_ffmpeg(self):
        data, _ = signal([("word", 1.0), ("silence", 1.0), ("word", 1.0)])
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.wav")
            at.render(data, RATE, [], src, codec="pcm_s16le")
            loaded, rate = at.load_pcm(src)
            self.assertEqual((len(loaded), rate), (len(data), RATE))
            out = os.path.join(d, "cut.flac")
            dur = at.render(loaded, rate, [[1.2, 1.8]], out)
            self.assertAlmostEqual(dur, 2.4, places=3)
            again, _ = at.load_pcm(out)
            self.assertEqual(len(again), int(2.4 * RATE))
            mp3 = os.path.join(d, "cut.mp3")
            at.to_mp3(out, mp3)
            self.assertGreater(os.path.getsize(mp3), 1000)


if __name__ == "__main__":
    unittest.main()
