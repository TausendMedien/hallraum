# Hallraum

**A home for your podcast: transcribe, structure, publish**
*Ein Zuhause für deinen Podcast: transkribieren, gliedern, veröffentlichen* · [Deutsche Version](README.de.md)

Hallraum is a self-hosted web app for finishing and publishing podcast episodes as a team – with a searchable transcript, chapter marks and topic playlists that work across all episodes.

Editing the audio stays in the tools you already use. Hallraum takes care of everything after that: transcription, chapters, tags, checklist, listening page and (soon) the podcast feed. One installation can host several podcasts, each with its own team and design.

> **How this project came about**
> Hallraum started as a fun project. I bring 20 years of development experience, but no programming experience: the code was written through *vibe coding*, in conversation with an AI (Claude Code). I described what the app should do and tested the results. Please look at it with a critical eye – feedback, bug reports and improvements are very welcome.
> – Ulrich Tausend

## Languages

Hallraum is developed in English. **German** is the first additional language, and it goes beyond menus:

- **Interface:** English and German, chosen per person (or from the browser language). Public pages use the podcast's language.
- **Transcription:** the spoken language is detected automatically; the transcription worker uses language-specific prompts so that hesitations are written down verbatim.
- **Filler words** are detected per language. German has its own list (*äh, ähm, öh, hm …*), and words that are fillers in one language but real words in another are handled correctly – e.g. English *um* is a filler, German *um* (as in *um … zu*) is not. A second list of "soft" fillers (*also, halt, sozusagen …* / *like, basically …*) is prepared for the planned auto-cut module.
- **Claude suggestions** (optional) come back in the podcast's language.

Adding a language: a dictionary in `app/locales/`, filler lists in `app/lib/languages.js` and a Whisper prompt in `worker/worker.py`.

## What it can do (stage 1)

**Editorial area**
- Team login, invitation links, roles admin / editor, several podcasts per installation
- Seasons and episodes, upload of the edited main part (WAV, MP3, M4A); an MP3 for publishing is created
- Transcription by a **transcription worker** on a separate computer (WhisperX: word-level timestamps, speaker detection). Recordings never leave your own infrastructure.
- Transcript editor: correct words without losing timestamps; name speakers; click a word to jump there in the player; filler words are marked
- Chapters and tagged sections – accept suggestions from Claude (optional) or create your own by selecting text in the transcript
- Shared tag list per podcast: rename and merge
- Checklist per episode (automatically detected and manual steps), overview with progress and next step
- Change log ("last changed by …") and a notice when two people edit at the same time

**Listening page** (per podcast at `/<short-name>`)
- Player with speed control, ±15 seconds, remembered position and keyboard control
- Chapter list with highlighting, transcript that follows along, click a word to jump there
- Search within an episode and across all episodes
- Topic playlists: hear all sections with a tag from all episodes in a row
- Links to a position (`?t=seconds`), content warnings before playback
- Design per podcast (colours, pattern, cover), accessible (keyboard, contrast, transcript as real text)

**Planned:** teasers and intro mixing, RSS feed with chapters and transcript (Podcasting 2.0), scheduled publishing, guest preview, glossary, embeddable player, social media clips, "auto-cut" module (remove filler words and pauses with adjustable strength).

## Architecture

| Part | Folder | Runs on |
|---|---|---|
| Web app (editorial area + listening page) | `app/` | Web server with Node.js ≥ 22.13 |
| Transcription worker | `worker/` | Separate computer, e.g. a Mac (Python or Docker) |
| Data (SQLite + audio) | `data/` | Next to the app – **never** in Git |

The worker asks the app for jobs. It needs no open ports, and the app keeps working when it is switched off – jobs simply wait.

Tech: Node.js, Express, SQLite (built-in `node:sqlite`), server-rendered pages with a little vanilla JavaScript, no build step. Deliberately few dependencies so that running it stays simple.

## Try it locally

Requirements: Node.js ≥ 22.13, ffmpeg (`brew install ffmpeg`), Python 3.10–3.13 for the worker.

```bash
cp .env.example .env            # fill in, at least WORKER_TOKEN (openssl rand -base64 32)
cd app
npm install
npm run admin -- --name "Anna" --email anna@example.org --podcast "My Podcast" --slug my-podcast --language en
node --env-file=../.env server.js
```

Then open <http://localhost:3000/admin>. Start the worker in a second terminal:

```bash
cd app
npm run worker
```

On first start the worker sets up a Python environment and downloads the Whisper models (several GB in total). It only runs while the terminal is open – stop it with Ctrl+C.

Alternatively with Docker: `docker compose up --build` starts the app and the worker together.

## Transcription worker

- Against a server on the internet: set `WORKER_APP_URL=https://podcast.example.org` in `.env`, then `npm run worker`
- Model: `WHISPER_MODEL=large-v3-turbo` (default, about real time on a recent Mac) or `large-v3` (more accurate, much slower)
- Speaker detection: create a Hugging Face account, accept the conditions of `pyannote/speaker-diarization-community-1`, put the token into `HF_TOKEN`. Without a token everything is assigned to one person.

## Claude suggestions (optional)

With `ANTHROPIC_API_KEY` in `.env`, Claude suggests chapters and tagged sections. **Only the transcript text** is sent to the Claude API, never the audio. Everything else works without a key.

## Installing on a server

Hallraum runs wherever Node.js ≥ 22.13 is available – including many web hosts with Node support (e.g. Plesk with Passenger).

1. Get the code onto the server (`git clone`), run `npm ci --omit=dev` in `app/`
2. Set up a Node application: start file `app/server.js`, environment variables `WORKER_TOKEN`, optionally `ANTHROPIC_API_KEY`, `DATA_DIR` (a folder **outside** the public web directory), `NODE_ENV=production`
3. Enable HTTPS (e.g. Let's Encrypt)
4. Run `node app/scripts/create-admin.js --name … --email … --podcast … --slug …` once
5. Raise the web server's upload limit to at least 1 GB (nginx: `client_max_body_size 2000m;`)
6. Without ffmpeg on the server, the worker creates the MP3 automatically

Updates: `git pull`, `npm ci --omit=dev`, restart the application. Backup: copy the `DATA_DIR` folder (database + audio) regularly.

## Tests

```bash
cd app && npm test
```

## Licence

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later).

In short: you may use, change and share Hallraum freely. If you run a **modified** version as a web service for others, you must make the source code of your changes available to its users. If you use Hallraum unchanged and only adapt it through its settings, you have no additional obligations.
