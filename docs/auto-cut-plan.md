# Plan: the auto-cut module

Auto-cut removes hesitation sounds ("äh", "um") and filler words ("also", "like"), and shortens long pauses in an episode's main audio. Every proposed cut is shown in the transcript editor, grouped by how sure Hallraum is. The team sets the options, checks the marks, and then cuts everything marked with one click. The original recording is never changed and stays downloadable.

## Decisions

1. **The original stays downloadable** for the team, next to the cut version.
2. **Three separate settings instead of one level:** pauses, hesitation sounds and filler words are each set on their own.
3. **Filler words are part of the first version**, not only hesitation sounds.
4. **Every proposed cut gets a certainty group,** so the team can see at a glance what is safe to cut and where a human should listen.

## What is already there

- **Word timestamps:** every transcript word has a start and end time and a Whisper confidence (`c`). Hesitation sounds are already flagged (`f: 1`).
- **Word lists per language** in `app/lib/languages.js`: `fillers` (hesitation sounds) and `softFillers` (filler words that are often real words).
- **Pause detection:** `pauses()` in `app/lib/transcript.js`.
- **Job queue** between app and worker. The worker only rejects job types other than `transcribe` so far.
- **Database fields:** `podcasts.autocut_default`, `episodes.autocut_level`, `audio_files.variant` (raw / cut). The two level fields are replaced by the new settings (see below). Database changes go into `migrate()` in `app/lib/db.js`, which adds columns to existing databases.

## Main design decision: keep the original timeline

Every cut moves all later times: transcript words, chapters, sections and `?t=` links. So:

- **All data keeps the times of the original recording.** The transcript editor, chapters and tags don't change.
- **The cuts are saved as a list of time ranges.** Two functions translate between the timelines: `toCut(t)` and `toOriginal(t)`.
- **Translation happens only for listeners.** The listening page and the later RSS feed play the cut audio and convert every time when it is displayed.

## The three settings

Each podcast has default settings. Each episode can override them.

| Setting | Options |
|---|---|
| **Pauses** | Off, or shorten pauses longer than *X* seconds down to *Y* seconds (for example longer than 1.2 s → 0.7 s). A separate, more generous value for pauses at a change of speaker, since those sound natural. |
| **Hesitation sounds** ("äh", "um") | Off / cut "certain" / cut "certain + likely" / cut all |
| **Filler words** ("also", "halt", "like", "so") | Off / cut "certain" / cut "certain + likely" / cut all |

Stored as JSON: `podcasts.autocut_settings` and `episodes.autocut_settings` (NULL = use the podcast's settings). The old `autocut_default` and `autocut_level` fields are converted on migration.

Pauses have no group setting of their own: when shortening is on, *certain* and *likely* pauses are marked, *unsure* ones are listed for a human to decide.

## Certainty groups

Every proposed cut is put in one of three groups, shown in colour in the editor:

| Group | Meaning | Colour |
|---|---|---|
| **Certain** | Can be cut without listening | green |
| **Likely** | Probably right, worth a quick listen | yellow |
| **Unsure** | A human should decide | red |

How the group is decided:

**Hesitation sounds** start as *certain*, since the word lists only contain pure sounds. They move down a group when:
- Whisper's confidence for the word is low.
- The word is very short (under ~80 ms) or very long (over ~1.5 s), which points to a wrong timestamp.
- It sits directly against the next word with no gap, so a cut could clip that word.

**Filler words** start as *unsure* and move up when the context shows they carry no meaning:
- They stand at the start of a sentence followed by a comma or short pause ("Also, …", "So, …").
- They are repeated ("halt halt", "like, like").
- They are surrounded by short pauses.
- They stay *unsure* or are never proposed when they are part of a phrase ("so that", "kind of a car", "ja" as an answer after a change of speaker, "genau" as a reply).

Optionally, **Claude can rate filler words in context** (only the transcript text is sent, as for chapters today). Without an API key, the rules above are used.

**Pauses** are rated with the audio itself (see phase 2):
- *Certain:* the gap is really quiet.
- *Likely:* quiet, but at a change of speaker.
- *Unsure:* the gap is not quiet (music, laughter, breathing, background noise) or very long (over ~5 s, which may be intended).

## Editing workflow

1. Open the **auto-cut panel** in the transcript editor and set the three options. The podcast's defaults are already filled in.
2. Hallraum **marks every cut the options cover**, coloured by group. Shortened pauses get a marker with the old and new length.
3. Click any mark to switch it on or off. Filter the view to show only one group, for example to go through all *unsure* marks.
4. **Preview:** the player skips the marked ranges right away in the browser, without rendering.
5. **"Cut everything marked"** sends a job to the worker, which renders the cut audio.

Changing an option later re-marks the transcript but keeps cuts the team switched on or off by hand.

## Phases

### Phase 1: settings and cut proposals (logic, no interface) – done
Implemented in `app/lib/autocut.js`, tested in `app/test/autocut.test.js`.

- `app/lib/autocut.js`:
  - `proposeCuts(words, gaps, settings, language)` returns a list of cuts, each with time range, type (pause / hesitation / filler), certainty group and the reason.
  - `toCut()` and `toOriginal()`.
- New database fields and migration.
- Unit tests in English and German, including that German "um" is never cut and "ja" as an answer is not proposed as *certain*.

### Status of phases 2–6 – done, with tuning still to do on real episodes

| Phase | Where | Tested how |
|---|---|---|
| 2 Measuring pauses | `worker/audio_tools.py` (`measure_gaps`), job type `analyze`, `transcripts.gaps` | Python tests with synthetic audio (silence vs. music); run once against the app with a test recording |
| 3 Editor | auto-cut panel and marks in `app/public/js/editor.js`, API in `app/routes/api.js` | end-to-end test in `app/test/app.test.js`; checked in the browser |
| 4 Cutting | `worker/audio_tools.py` (`snap_ranges`, `render`), job type `autocut` | Python tests (exact length, no clicks, snapping); real cut of a test recording by the worker |
| 5 Publishing | `listenerAudio()` in `app/lib/autocut-state.js`, `app/routes/public.js`, downloads in `app/routes/media.js`, checklist | end-to-end test (times on the listening page, search, downloads, outdated cut) |
| 6 Tuning | `app/scripts/autocut-report.js` (`npm run autocut-report`) and [auto-cut-tuning.md](auto-cut-tuning.md) | tool is ready; **the actual tuning needs real episodes and listening** |

Not covered yet: the pause measurement inside a real WhisperX transcription run (WhisperX isn't installed in the development environment), and listening tests of cut episodes.

### Phase 2: audio analysis for pauses
- During transcription, the worker also measures the loudness of every gap between words and sends it back with the transcript.
- For existing transcripts, a new job type `analyze` does only this measurement.

### Phase 3: review in the transcript editor
- The auto-cut panel, coloured marks, toggling, group filter and preview, as described above.
- Decisions are saved with the transcript version and logged in the change log.

### Phase 4: rendering in the worker (job type `autocut`)
- The app creates a job with the list of switched-on cuts.
- The worker:
  1. downloads the original audio.
  2. moves each cut point to the quietest spot nearby (within about ±80 ms), because timestamps for "äh" are often imprecise.
  3. cuts with ffmpeg using very short crossfades (10–30 ms) to avoid clicks. Pauses are shortened with their own room sound, not filled with digital silence.
  4. uploads the cut file plus an MP3 and reports back the exact cuts it made, so the time translation is exact.
- The app saves this as a new audio file with `variant = 'cut'`.

### Phase 5: publishing and downloads
- The listening page plays the cut version when one exists. Chapters, transcript, search hits and `?t=` links are translated to the cut timeline.
- In the editorial area, both the **original** and the **cut version** can be downloaded and played.
- New automatic checklist step "Auto-cut reviewed" when any setting is not off.
- If the audio or transcript changes afterwards, the cut version is marked as outdated and has to be rendered again.

### Phase 6: real-world tuning
- Test with real episodes in German and English; tune the group rules, thresholds and margins.
- Measure how often Whisper misses hesitation sounds, since what isn't in the transcript can't be cut.
- How to do it: [auto-cut-tuning.md](auto-cut-tuning.md).

## Risks

- **Whisper doesn't write down every "äh",** even with verbatim prompts. Auto-cut reduces hesitations; it won't remove all of them.
- **Filler words are often real words.** That is why they start as *unsure* and only move up with clear signs.
- **Cuts that are too tight sound unnatural.** Use conservative defaults.
- **Music or jingles inside the main audio** could be taken for pauses. The loudness check in phase 2 guards against this.
