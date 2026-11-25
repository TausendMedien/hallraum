import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/db.js';
import { logChange } from '../lib/audit.js';
import { sendRange } from '../lib/audio.js';
import { sanitizeWords, markFillers, fillMissingTimes, reindexTranscript } from '../lib/transcript.js';
import { mergeRanges } from '../lib/autocut.js';
import { currentAudio } from '../lib/episodes.js';

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : null);

// Measured loudness between words, from the worker
function sanitizeGaps(input) {
  if (!Array.isArray(input)) return null;
  return input.map((g) => ({ start: num(g?.start), end: num(g?.end), quiet: Boolean(g?.quiet), db: num(g?.db) }))
    .filter((g) => g.start != null && g.end != null && g.end > g.start).slice(0, 200000);
}
const sanitizeLoudness = (l) => (l && typeof l === 'object'
  ? { speechDb: num(l.speechDb), floorDb: num(l.floorDb), thresholdDb: num(l.thresholdDb) } : null);

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
    // Older workers only ask for 'transcribe'; newer ones also for 'analyze' and 'autocut'
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
    const out = {
      id: job.id, type: job.type, episodeId: job.episode_id, options: { ...JSON.parse(job.options || '{}'), podcastLanguage: ep?.language },
      audio: { url: `/api/worker/jobs/${job.id}/audio`, name: audio?.original_name, mime: audio?.mime, duration: audio?.duration },
    };
    if (job.type === 'analyze') {
      const tr = db.get('SELECT words FROM transcripts WHERE episode_id = ?', job.episode_id);
      out.words = tr ? JSON.parse(tr.words).map((x) => [x.s, x.e]) : [];
    }
    res.json({ job: out });
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

  // Auto-cut: the worker uploads the cut audio (FLAC) and its MP3 before sending the result
  const cutFile = (j, type) => {
    const a = db.get('SELECT * FROM audio_files WHERE id = ?', j.audio_file_id);
    const dir = path.dirname(path.join(DATA_DIR, a.original_path));
    return path.join(dir, `cut-${j.id}.${type === 'mp3' ? 'mp3' : 'flac'}`);
  };
  r.post('/jobs/:id/cut-file', (req, res, next) => {
    const j = runningJob(req.params.id);
    if (j.type !== 'autocut') throw Object.assign(new Error('not an auto-cut job'), { status: 400, expose: true });
    const target = cutFile(j, req.query.type);
    const tmp = target + '.part';
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, target); res.json({ ok: true }); });
    out.on('error', next);
  });

  const finish = (j) => db.run(`UPDATE jobs SET status = 'done', finished_at = datetime('now'), progress = NULL WHERE id = ?`, j.id);
  const conflict = (msg) => Object.assign(new Error(msg), { status: 409, expose: true });

  r.post('/jobs/:id/result', (req, res) => {
    const j = runningJob(req.params.id);
    const ep = db.get('SELECT * FROM episodes WHERE id = ?', j.episode_id);
    if (!ep) throw conflict('episode no longer exists');
    if (j.type === 'analyze') return resultAnalyze(req, res, j, ep);
    if (j.type === 'autocut') return resultAutocut(req, res, j, ep);
    const lang = String(req.body?.language || '').slice(0, 5) || null;
    const words = markFillers(sanitizeWords(fillMissingTimes(req.body?.words || [])), lang || 'en');
    if (!words.length) throw Object.assign(new Error('empty transcript'), { status: 400, expose: true });
    const gaps = sanitizeGaps(req.body?.gaps);
    const loudness = sanitizeLoudness(req.body?.loudness);
    db.tx(() => {
      db.run(`INSERT INTO transcripts (episode_id, audio_file_id, language, words, gaps, loudness, version, updated_at, updated_by) VALUES (?,?,?,?,?,?,1,datetime('now'),NULL)
              ON CONFLICT (episode_id) DO UPDATE SET audio_file_id = excluded.audio_file_id, language = excluded.language, words = excluded.words,
              gaps = excluded.gaps, loudness = excluded.loudness, version = transcripts.version + 1, updated_at = excluded.updated_at, updated_by = NULL`,
      ep.id, j.audio_file_id, lang, JSON.stringify(words), gaps ? JSON.stringify(gaps) : null, loudness ? JSON.stringify(loudness) : null);
      reindexTranscript(db, ep.id, ep.podcast_id, words);
      const dur = Number(req.body?.duration);
      if (Number.isFinite(dur) && dur > 0) db.run('UPDATE audio_files SET duration = COALESCE(duration, ?) WHERE id = ?', dur, j.audio_file_id);
      // Pre-fill speaker ids with placeholder names
      const names = JSON.parse(ep.speaker_names || '{}');
      for (const sp of new Set(words.map((w) => w.sp).filter(Boolean))) if (!names[sp]) names[sp] = sp.replace(/^SPEAKER_0?/, 'Person ');
      db.run('UPDATE episodes SET speaker_names = ? WHERE id = ?', JSON.stringify(names), ep.id);
      finish(j);
      logChange(db, { user: null, podcastId: ep.podcast_id, episodeId: ep.id, type: 'transcript', id: ep.id,
        key: 'log.transcriptCreated', params: { words: words.length, language: lang || '?', fillers: words.filter((w) => w.f).length } });
    });
    heartbeat(req.body?.info);
    res.json({ ok: true });
  });

  // Loudness of the pauses for an existing transcript
  function resultAnalyze(req, res, j, ep) {
    const gaps = sanitizeGaps(req.body?.gaps);
    if (!gaps) throw Object.assign(new Error('gaps missing'), { status: 400, expose: true });
    db.tx(() => {
      db.run('UPDATE transcripts SET gaps = ?, loudness = ? WHERE episode_id = ?', JSON.stringify(gaps), JSON.stringify(sanitizeLoudness(req.body?.loudness)), ep.id);
      finish(j);
      logChange(db, { user: null, podcastId: ep.podcast_id, episodeId: ep.id, type: 'autocut', id: ep.id,
        key: 'log.pausesMeasured', params: { n: gaps.length, quiet: gaps.filter((g) => g.quiet).length } });
    });
    heartbeat(req.body?.info);
    res.json({ ok: true });
  }

  // The cut version: a new audio file next to the original (which stays unchanged)
  function resultAutocut(req, res, j, ep) {
    const flac = cutFile(j, 'audio'), mp3 = cutFile(j, 'mp3');
    const raw = currentAudio(db, ep.id, 'main');
    if (!raw || raw.id !== j.audio_file_id) {
      fs.rmSync(flac, { force: true }); fs.rmSync(mp3, { force: true });
      db.run(`UPDATE jobs SET status = 'error', error = 'the original audio was replaced', finished_at = datetime('now') WHERE id = ?`, j.id);
      throw conflict('the original audio was replaced in the meantime');
    }
    if (!fs.existsSync(flac)) throw Object.assign(new Error('cut audio was not uploaded'), { status: 400, expose: true });
    const applied = mergeRanges((Array.isArray(req.body?.cuts) ? req.body.cuts : [])
      .map((c) => (Array.isArray(c) ? { start: num(c[0]), end: num(c[1]) } : { start: num(c?.start), end: num(c?.end) }))
      .filter((c) => c.start != null && c.end != null));
    const opts = JSON.parse(j.options || '{}');
    const removed = Math.round(applied.reduce((s, c) => s + c.end - c.start, 0) * 1000) / 1000;
    const duration = num(req.body?.duration) ?? (raw.duration != null ? raw.duration - removed : null);
    const info = { requested: opts.ranges || [], applied, removed, transcriptVersion: opts.transcriptVersion ?? null, settings: opts.settings ?? null };
    const name = raw.original_name.replace(/\.[^.]+$/, '') + ' (auto-cut).flac';
    db.tx(() => {
      db.run(`UPDATE audio_files SET is_current = 0 WHERE episode_id = ? AND kind = 'main' AND variant = 'cut'`, ep.id);
      const id = Number(db.run(`INSERT INTO audio_files (podcast_id, episode_id, kind, variant, is_current, original_name, original_path, mp3_path, mime, size, duration, created_by, source_id, cut_info)
        VALUES (?,?, 'main', 'cut', 1, ?,?,?, 'audio/flac', ?,?,?,?,?)`, ep.podcast_id, ep.id, name, path.relative(DATA_DIR, flac),
      fs.existsSync(mp3) ? path.relative(DATA_DIR, mp3) : null, fs.statSync(flac).size, duration, opts.userId ?? null, raw.id, JSON.stringify(info)).lastInsertRowid);
      finish(j);
      logChange(db, { user: null, podcastId: ep.podcast_id, episodeId: ep.id, type: 'audio', id,
        key: 'log.autocutDone', params: { n: applied.length, seconds: Math.round(removed) } });
    });
    heartbeat(req.body?.info);
    res.json({ ok: true });
  }

  r.post('/jobs/:id/fail', (req, res) => {
    const j = runningJob(req.params.id);
    db.run(`UPDATE jobs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?`, String(req.body?.error || 'unknown error').slice(0, 1000), j.id);
    res.json({ ok: true });
  });

  return r;
}
