# Tuning auto-cut with real episodes

Auto-cut's rules were written without real recordings. This guide describes how to check and adjust them once real episodes have gone through it. It is phase 6 of [the auto-cut plan](auto-cut-plan.md).

## 1. Collect material

Use at least three episodes per language (German and English), ideally with different speakers and recording conditions.

For each episode:

1. Transcribe it with a worker that includes auto-cut (it measures the pauses automatically). For older transcripts, press **Measure pauses** in the auto-cut panel.
2. Turn everything on in the auto-cut panel (pauses on, hesitation sounds and filler words at "cut all").
3. Go through the marks with **Edit cuts** on. Switch off every mark that should stay and switch on every one that is missing. Use **Preview with cuts** to listen.
4. Press **Cut everything marked** and listen to the cut version, especially the joints.

Your decisions in step 3 are stored. They are the most valuable data for tuning.

## 2. Read the report

```bash
cd app
node --env-file=../.env scripts/autocut-report.js
```

Options: `--podcast <slug>`, `--episode <id>`, `--json`.

For each episode the report shows:

- how many hesitation sounds Whisper wrote down per minute. If this is close to zero, Whisper is leaving them out and auto-cut can't find them (see section 4).
- how many pauses were measured as quiet.
- all candidates per type and certainty group, with the time they would remove.
- **every mark where the team disagreed with the automatic decision**, with the words and the reasons behind the group.

At the end, it counts the disagreements per type, group and decision across all episodes.

## 3. What to adjust

| You see | Likely cause | Where to change it |
|---|---|---|
| Many *certain* hesitation sounds switched off | A word in the hesitation list is a real word in your language, or Whisper attaches "äh" to the wrong place | `fillers` in `app/lib/languages.js`; the confidence and length limits in `proposeCuts()` in `app/lib/autocut.js` |
| Many *unsure* or *likely* filler words switched on | The signs that move fillers up are too strict | the gap limits (0.3 s after, 0.25 s around) in `proposeCuts()` |
| Many filler words switched off | A filler is used as a real word in a certain context | add the word before or after it to `FILLER_RULES` in `app/lib/autocut.js` (`prev`, `next`, `turnStart`) |
| A filler word that should be proposed never shows up | It is missing from the list | `softFillers` in `app/lib/languages.js` |
| Cut words sound clipped | The safety margin is too small | `PAD_MIN_KEEP` and `PAD_MAX_KEEP` in `app/lib/autocut.js`; `window` in `snap_ranges()` in `worker/audio_tools.py` |
| Joints click or pump | Crossfade too short or too long | `fade` in `render_chunks()` in `worker/audio_tools.py` (default 20 ms) |
| Quiet pauses measured as "not quiet" (or the other way round) | The loudness threshold doesn't fit the recording | `threshold` in `measure_gaps()` in `worker/audio_tools.py`; the report shows speech level and threshold per episode |
| Shortened pauses feel rushed | Default lengths too short | the podcast's auto-cut settings (no code change needed) |

After a change, run the tests (`cd app && npm test`, `cd worker && python -m unittest test_audio_tools.py`) and add a test for the case you fixed, so it stays fixed.

## 4. If Whisper leaves out hesitation sounds

The worker asks Whisper for a verbatim transcript with a prompt that contains hesitation sounds (`PROMPTS` in `worker/worker.py`). If an episode still shows almost no hesitation sounds per minute:

- check the language. The prompt only exists for German and English.
- try `WHISPER_MODEL=large-v3`, which is slower but often more verbatim.
- adjust the prompt to the speaker's typical sounds.

## 5. Record what you changed

Note each change and the reason (for example in the commit message). Mention which episodes it was tested with, without naming private content.
