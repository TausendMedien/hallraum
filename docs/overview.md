# Hallraum in short

A quick introduction for new collaborators. It's based on the README and a look at the code; the automated tests were not run while writing it.

## 1. What is Hallraum for?

Hallraum is a web app for podcast teams that handles everything after the audio has been edited. It transcribes the episode, adds chapters and topics, and publishes it on a listening page. You install it on your own server, and the recordings never go to an outside transcription service. One installation can host several podcasts, each with its own team and design.

## 2. What can it do?

**For the team (`/admin`):**

- Log in, invite people by link, and give them a role: admin or editor.
- Create seasons and episodes, and upload the edited audio (WAV, MP3 or M4A). Hallraum creates an MP3 for publishing.
- Get an automatic transcript with a timestamp for every word and detection of who is speaking.
- Correct the transcript in an editor: fix words, name the speakers, and click a word to jump to that spot in the audio. Filler words like "um" or "äh" are marked.
- Add chapters and topic sections (tags). Claude can suggest them, or the team marks them by selecting text.
- Work through a checklist per episode, see a log of who changed what, and get a warning when two people edit at the same time.
- **Auto-cut:** shorten long pauses and remove hesitation sounds and filler words. Every proposal is marked green, yellow or red by how sure Hallraum is; the team checks the marks and cuts with one click. The original stays downloadable.

**For listeners (`/<podcast-name>`):**

- A player with speed control, ±15-second skips and keyboard control.
- A chapter list and a transcript that follows along with the audio.
- Search within one episode or across all of them.
- Topic playlists that play every section with the same tag, across all episodes.
- Links to an exact moment in an episode, content warnings before playback, and a design for each podcast.

The interface is in English and German. Filler words are recognised per language.

## 3. How does it work (technically)?

| Part | What it is |
|---|---|
| **Web app** (`app/`) | Node.js 22 with Express. Pages are built on the server, with a little plain JavaScript and no build step. About 3,600 lines of code. |
| **Database** | SQLite, using the database built into Node. It has 18 tables (podcasts, episodes, transcript words, chapters, tags, jobs and others). The database and the audio files live in a `data/` folder, never in git. |
| **Transcription worker** (`worker/`) | A Python script that runs on a separate computer, for example a Mac. It transcribes with WhisperX, uses pyannote to tell the speakers apart, measures the pauses and renders auto-cut versions. |
| **Claude** (optional) | Sends only the transcript text to the Claude API and gets back suggested chapters and tags. |

The worker regularly asks the web app for new jobs. When it gets one, it downloads the audio, transcribes it and sends the words with their timestamps back. This means the worker needs no open ports, and if it is switched off, jobs simply wait. Claude, the worker and ffmpeg are all optional, and the app still works without them.

The code is on GitHub at `TausendMedien/hallraum` under the AGPL-3.0 licence. There are automated tests for the app (Node) and for the worker's audio functions (Python).

## 4. What does it still lack?

- **An RSS feed.** There is no podcast feed in the code yet, so episodes can't be published to Apple Podcasts, Spotify and similar apps. This is the biggest gap.
- **Scheduled publishing** and a guest preview before an episode goes live.
- **Teasers and intro mixing:** putting short clips and the intro together.
- **Fine-tuning of auto-cut** with real episodes. The module works, but its rules haven't been checked against real recordings yet (see `docs/auto-cut-tuning.md`).
- **Other planned features:** a glossary, an embeddable player and clips for social media.
- **Testing and review.** The code was written through conversation with Claude ("vibe coding") and needs a critical review by an experienced developer. Nobody has tried a real server installation of this version yet.
