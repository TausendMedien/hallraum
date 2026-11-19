import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/db.js';
import { logChange } from '../lib/audit.js';
import { sendRange } from '../lib/audio.js';
import { sanitizeWords, markFillers, fillMissingTimes, reindexTranscript } from '../lib/transcript.js';

const STALE_HOURS = 6; // running jobs without any sign of life are handed out again after this
const MAX_ATTEMPTS = 3;

// API for the transcription worker (runs on a separate computer).
// The worker authenticates with WORKER_TOKEN; the app never depends on the worker being online.
export default function workerRoutes(db) {
  const r = Router();

  r.use((req, res, next) => {
    const expected = process.env.WORKER_TOKEN || '';
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ok = expected.length >= 16 && got.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'invalid worker token' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const heartbeat = (info) => db.run(`INSERT INTO settings (key, value) VALUES ('worker_heartbeat', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify({ at: new Date().toISOString(), info: info ? String(info).slice(0, 200) : '' }));

  r.post('/heartbeat', (req, res) => { heartbeat(req.body?.info); res.json({ ok: true }); });

  // Claim the next job (atomically)
  r.post('/next', (req, res) => {
    heartbeat(req.body?.info);
    const types = Array.isArray(req.body?.types) && req.body.types.length ? req.body.types.map(String) : ['transcribe'];
    const job = db.tx(() => {
      // Reset stuck jobs
      db.run(`UPDATE jobs SET status = CASE WHEN attempts >= ? THEN 'error' ELSE 'queued' END,
              error = CASE WHEN attempts >= ? THEN 'too many attempts without response' ELSE error END
              WHERE status = 'running' AND claimed_at < datetime('now', ?)`, MAX_ATTEMPTS, MAX_ATTEMPTS, `-${STALE_HOURS} hours`);
      const j = db.get(`SELECT * FROM jobs WHERE status = 'queued' AND type IN (${types.map(() => '?').join(',')}) ORDER BY id LIMIT 1`, ...types);
      if (!j) return null;
      db.run(`UPDATE jobs SET status = 'running', claimed_at = datetime('now'), attempts = attempts + 1, progress = NULL, error = NULL WHERE id = ?`, j.id);
      return j;
    });
    if (!job) return res.json({ job: null });
    const audio = db.get('SELECT original_name, mime, duration FROM audio_files WHERE id = ?', job.audio_file_id);
    const ep = db.get('SELECT e.title, e.speaker_names, p.language FROM episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.id = ?', job.episode_id);
    res.json({ job: {
      id: job.id, type: job.type, episodeId: job.episode_id, options: { ...JSON.parse(job.options || '{}'), podcastLanguage: ep?.language },
      audio: { url: `/api/worker/jobs/${job.id}/audio`, name: audio?.original_name, mime: audio?.mime, duration: audio?.duration },
    } });
  });

  const runningJob = (id) => {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(id));
    if (!j) { const e = new Error('job not found'); e.status = 404; e.expose = true; throw e; }
    if (j.status !== 'running') { const e = new Error(`job is not running (${j.status})`); e.status = 409; e.expose = true; throw e; }
    return j;
  };

  r.get('/jobs/:id/audio', (req, res) => {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id));
    if (!j) return res.status(404).end();
    const a = db.get('SELECT * FROM audio_files WHERE id = ?', j.audio_file_id);
    if (!a) return res.status(404).end();
    sendRange(req, res, path.join(DATA_DIR, a.original_path), a.mime, 'no-store');
  });

  r.post('/jobs/:id/progress', (req, res) => {
    const j = runningJob(req.params.id);
    db.run('UPDATE jobs SET progress = ?, claimed_at = datetime(\'now\') WHERE id = ?', String(req.body?.progress || '').slice(0, 60), j.id);
    heartbeat(req.body?.info);
    res.json({ ok: true });
  });

  // MP3 from the worker (only when the server has no ffmpeg)
  r.post('/jobs/:id/mp3', (req, res, next) => {
    const j = runningJob(req.params.id);
    const a = db.get('SELECT * FROM audio_files WHERE id = ?', j.audio_file_id);
    if (!a) throw Object.assign(new Error('audio file no longer exists'), { status: 409, expose: true });
    const target = path.join(DATA_DIR, a.original_path).replace(/\.[^.]+$/, '') + '.pub.mp3';
    const tmp = target + '.part';
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => {
      fs.renameSync(tmp, target);
      db.run('UPDATE audio_files SET mp3_path = ? WHERE id = ?', path.relative(DATA_DIR, target), a.id);
      res.json({ ok: true });
    });
    out.on('error', next);
  });

  r.post('/jobs/:id/result', (req, res) => {
    const j = runningJob(req.params.id);
    const ep = db.get('SELECT * FROM episodes WHERE id = ?', j.episode_id);
    if (!ep) throw Object.assign(new Error('episode no longer exists'), { status: 409, expose: true });
    const lang = String(req.body?.language || '').slice(0, 5) || null;
    const words = markFillers(sanitizeWords(fillMissingTimes(req.body?.words || [])), lang || 'en');
    if (!words.length) throw Object.assign(new Error('empty transcript'), { status: 400, expose: true });
    db.tx(() => {
      db.run(`INSERT INTO transcripts (episode_id, audio_file_id, language, words, version, updated_at, updated_by) VALUES (?,?,?,?,1,datetime('now'),NULL)
              ON CONFLICT (episode_id) DO UPDATE SET audio_file_id = excluded.audio_file_id, language = excluded.language, words = excluded.words,
              version = transcripts.version + 1, updated_at = excluded.updated_at, updated_by = NULL`, ep.id, j.audio_file_id, lang, JSON.stringify(words));
      reindexTranscript(db, ep.id, ep.podcast_id, words);
      const dur = Number(req.body?.duration);
      if (Number.isFinite(dur) && dur > 0) db.run('UPDATE audio_files SET duration = COALESCE(duration, ?) WHERE id = ?', dur, j.audio_file_id);
      // Pre-fill speaker ids with placeholder names
      const names = JSON.parse(ep.speaker_names || '{}');
      for (const sp of new Set(words.map((w) => w.sp).filter(Boolean))) if (!names[sp]) names[sp] = sp.replace(/^SPEAKER_0?/, 'Person ');
      db.run('UPDATE episodes SET speaker_names = ? WHERE id = ?', JSON.stringify(names), ep.id);
      db.run(`UPDATE jobs SET status = 'done', finished_at = datetime('now'), progress = NULL WHERE id = ?`, j.id);
      logChange(db, { user: null, podcastId: ep.podcast_id, episodeId: ep.id, type: 'transcript', id: ep.id,
        key: 'log.transcriptCreated', params: { words: words.length, language: lang || '?', fillers: words.filter((w) => w.f).length } });
    });
    heartbeat(req.body?.info);
    res.json({ ok: true });
  });

  r.post('/jobs/:id/fail', (req, res) => {
    const j = runningJob(req.params.id);
    db.run(`UPDATE jobs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?`, String(req.body?.error || 'unknown error').slice(0, 1000), j.id);
    res.json({ ok: true });
  });

  return r;
}
