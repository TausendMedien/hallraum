-- Data model. All times are seconds relative to the main audio part.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  locale TEXT,                                 -- UI language (en, de); NULL = browser language
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_podcast_id INTEGER,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podcasts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT '',
  explicit INTEGER NOT NULL DEFAULT 0,
  cover_path TEXT,
  theme TEXT NOT NULL DEFAULT '{}',           -- JSON: colours, pattern
  content_warning_options TEXT NOT NULL DEFAULT '[]', -- JSON list of preset content warnings
  autocut_settings TEXT NOT NULL DEFAULT '{}', -- JSON: auto-cut settings, see lib/autocut.js ('{}' = all off)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','editor')),
  PRIMARY KEY (user_id, podcast_id)
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  podcast_id INTEGER REFERENCES podcasts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_by INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  UNIQUE (podcast_id, number)
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
  number INTEGER,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  guest TEXT NOT NULL DEFAULT '',
  cover_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  explicit INTEGER NOT NULL DEFAULT 1,
  content_warnings TEXT NOT NULL DEFAULT '[]',
  consent_date TEXT,
  consent_note TEXT NOT NULL DEFAULT '',
  guest_share_enabled INTEGER NOT NULL DEFAULT 0,
  speaker_names TEXT NOT NULL DEFAULT '{}',   -- JSON: {"SPEAKER_00":"Anna"}
  autocut_settings TEXT,                       -- JSON: auto-cut overrides; NULL = podcast settings
  publish_at TEXT,
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (podcast_id, slug)
);

-- kind: main | moderation | intro | music | name ; variant: raw | cut (auto-cut)
-- A cut version points to its original (source_id); cut_info holds the requested and applied cuts (JSON).
CREATE TABLE IF NOT EXISTS audio_files (
  id INTEGER PRIMARY KEY,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT 'raw',
  is_current INTEGER NOT NULL DEFAULT 1,
  original_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  mp3_path TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_id INTEGER REFERENCES audio_files(id) ON DELETE CASCADE,
  cut_info TEXT
);

-- Transcript as JSON list of words {w, s, e, sp, f(iller), c(onfidence)}
CREATE TABLE IF NOT EXISTS transcripts (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  audio_file_id INTEGER REFERENCES audio_files(id),
  language TEXT,
  words TEXT NOT NULL,
  gaps TEXT,      -- JSON: measured loudness between words [{start, end, quiet, db}] (auto-cut)
  loudness TEXT,  -- JSON: {speechDb, floorDb, thresholdDb} of that measurement
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text, episode_id UNINDEXED, podcast_id UNINDEXED, start UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start REAL NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'redaktion' CHECK (origin IN ('claude','redaktion')),
  accepted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start REAL NOT NULL,
  end REAL NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'redaktion' CHECK (origin IN ('claude','redaktion')),
  accepted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (podcast_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS section_tags (
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, tag_id)
);

-- manual steps only; automatic steps are computed
CREATE TABLE IF NOT EXISTS checklist (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  PRIMARY KEY (episode_id, step)
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  podcast_id INTEGER,
  episode_id INTEGER,
  object_type TEXT NOT NULL,
  object_id INTEGER,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_episode ON changes(episode_id, at);

-- Jobs for the transcription worker. type: transcribe | analyze | autocut (see docs/auto-cut-plan.md)
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  audio_file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'transcribe',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  options TEXT NOT NULL DEFAULT '{}',
  progress TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);

-- Auto-cut: manual decisions per proposal ({"h:12.345": true, "p:40.100": false})
-- and the team's own cuts of any words ([{"start": 12.3, "end": 14.0}], word times of the original)
CREATE TABLE IF NOT EXISTS autocut (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  overrides TEXT NOT NULL DEFAULT '{}',
  own_cuts TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
