import fs from 'node:fs';
import path from 'node:path';
import Busboy from 'busboy';
import { DATA_DIR } from './db.js';
import { AUDIO_TYPES, findFfmpeg, probeDuration, toMp3 } from './audio.js';
import { randomToken } from './auth.js';
import { logChange } from './audit.js';

export const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2000) * 1024 * 1024;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Errors carry a translation key; the error handler translates them for the user
export function httpError(status, key, params) {
  const e = new Error(key);
  e.status = status; e.expose = true; e.i18n = { key, params };
  return e;
}

// Load an episode and check that the user is a member of its podcast
export function loadEpisode(db, req, id) {
  const ep = db.get('SELECT * FROM episodes WHERE id = ?', Number(id));
  if (!ep || !req.memberships?.some((m) => m.id === ep.podcast_id)) throw httpError(404, 'err.episodeNotFound');
  return ep;
}

export function currentAudio(db, episodeId, kind = 'main') {
  return db.get(`SELECT * FROM audio_files WHERE episode_id = ? AND kind = ? AND is_current = 1 ORDER BY id DESC LIMIT 1`, episodeId, kind);
}

// Stream a multipart upload to disk: form fields + exactly one file
export function receiveUpload(req, { dir, allowed, maxBytes = MAX_UPLOAD }) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } }); }
    catch { return reject(httpError(400, 'err.noUpload')); }
    const fields = {};
    let file = null, pending = null, failed = null;
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (name, stream, info) => {
      const ext = path.extname(info.filename || '').toLowerCase();
      if (!allowed[ext]) { failed = httpError(400, 'err.fileType', { ext: ext || '?', allowed: Object.keys(allowed).join(', ') }); stream.resume(); return; }
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${randomToken(6)}${ext}`);
      const out = fs.createWriteStream(target);
      let size = 0;
      stream.on('data', (d) => { size += d.length; });
      stream.on('limit', () => { failed = httpError(413, 'err.fileTooLarge'); });
      pending = new Promise((res2, rej2) => { out.on('finish', res2); out.on('error', rej2); });
      stream.pipe(out);
      file = { path: target, originalName: info.filename, mime: allowed[ext], ext, get size() { return size; } };
    });
    bb.on('error', reject);
    bb.on('close', async () => {
      try {
        if (pending) await pending;
        if (failed) { if (file) fs.rmSync(file.path, { force: true }); return reject(failed); }
        resolve({ fields, file: file ? { ...file, size: file.size } : null });
      } catch (e) { reject(e); }
    });
    req.pipe(bb);
  });
}

export async function saveAudioUpload(db, req, episode, kind = 'main') {
  const dir = path.join(DATA_DIR, 'audio', String(episode.podcast_id), String(episode.id));
  const { file } = await receiveUpload(req, { dir, allowed: AUDIO_TYPES });
  if (!file) throw httpError(400, 'err.chooseAudio');
  const duration = await probeDuration(file.path).catch(() => null);
  const audioId = db.tx(() => {
    db.run('UPDATE audio_files SET is_current = 0 WHERE episode_id = ? AND kind = ?', episode.id, kind);
    const r = db.run(`INSERT INTO audio_files (podcast_id, episode_id, kind, original_name, original_path, mime, size, duration, created_by)
                      VALUES (?,?,?,?,?,?,?,?,?)`, episode.podcast_id, episode.id, kind, file.originalName, path.relative(DATA_DIR, file.path), file.mime, file.size, duration, req.user.id);
    const id = Number(r.lastInsertRowid);
    logChange(db, { user: req.user, podcastId: episode.podcast_id, episodeId: episode.id, type: 'audio', id, key: 'log.audioUploaded', params: { kind: `@audio.kind.${kind}`, name: file.originalName } });
    if (kind === 'main') {
      // Queue a new transcription; drop older pending jobs
      db.run(`UPDATE jobs SET status = 'error', error = 'replaced by new upload' WHERE episode_id = ? AND status IN ('queued','running')`, episode.id);
      db.run(`INSERT INTO jobs (episode_id, audio_file_id, type, options) VALUES (?,?, 'transcribe', ?)`, episode.id, id,
        JSON.stringify({ language: null, needsMp3: !findFfmpeg() }));
    }
    return id;
  });
  // Create the MP3 for publishing in the background (if ffmpeg is available)
  if (findFfmpeg()) makeMp3(db, audioId).catch((e) => console.error('MP3 conversion failed:', e.message));
  return audioId;
}

export async function makeMp3(db, audioId) {
  const a = db.get('SELECT * FROM audio_files WHERE id = ?', audioId);
  if (!a) return;
  const src = path.join(DATA_DIR, a.original_path);
  if (a.mime === 'audio/mpeg') { db.run('UPDATE audio_files SET mp3_path = original_path WHERE id = ?', audioId); return; }
  const out = src.replace(/\.[^.]+$/, '') + '.pub.mp3';
  await toMp3(src, out);
  db.run('UPDATE audio_files SET mp3_path = ? WHERE id = ?', path.relative(DATA_DIR, out), audioId);
}

export async function saveImageUpload(req, dir) {
  const { fields, file } = await receiveUpload(req, { dir, allowed: IMAGE_TYPES, maxBytes: 10 * 1024 * 1024 });
  return { fields, file: file ? { ...file, rel: path.relative(DATA_DIR, file.path) } : null };
}

// File the player plays: the MP3 if available, otherwise the original
export function playablePath(a) {
  if (!a) return null;
  return a.mp3_path ? { file: path.join(DATA_DIR, a.mp3_path), mime: 'audio/mpeg' } : { file: path.join(DATA_DIR, a.original_path), mime: a.mime };
}

// The worker reports progress as codes ("aligning") or percentages ("42 %")
function progressLabel(t, code) {
  const key = `progress.${code}`;
  const s = t(key);
  return s === key ? code : s;
}

// Latest transcription job and worker heartbeat. Returns a translated label.
export function jobStatus(db, episodeId, t) {
  const job = db.get('SELECT * FROM jobs WHERE episode_id = ? AND type = ? ORDER BY id DESC LIMIT 1', episodeId, 'transcribe');
  const hb = db.get(`SELECT value FROM settings WHERE key = 'worker_heartbeat'`)?.value;
  let label = null;
  if (job && t) {
    label = job.status === 'queued' ? t('job.queued')
      : job.status === 'running' ? t('job.running') + (job.progress ? ' ' + progressLabel(t, job.progress) : '')
      : job.status === 'done' ? t('job.done') : t('job.error');
  }
  return { job, label, heartbeat: hb ? JSON.parse(hb) : null };
}
