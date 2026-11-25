import { Router } from 'express';
import path from 'node:path';
import { DATA_DIR } from '../lib/db.js';
import { sendRange } from '../lib/audio.js';
import { playablePath } from '../lib/episodes.js';

// Audio and images are only served through the app: unpublished episodes only for the team.
export default function mediaRoutes(db) {
  const r = Router();
  const member = (req, podcastId) => !!req.memberships?.some((m) => m.id === podcastId);

  r.get('/audio/:id', (req, res) => {
    const a = db.get('SELECT * FROM audio_files WHERE id = ?', Number.parseInt(req.params.id, 10));
    if (!a) return res.status(404).end();
    const ep = a.episode_id ? db.get('SELECT status FROM episodes WHERE id = ?', a.episode_id) : null;
    const isPublic = a.kind === 'main' && a.is_current && ep?.status === 'published';
    if (!isPublic && !member(req, a.podcast_id)) return res.status(403).end();
    const p = playablePath(a);
    sendRange(req, res, p.file, p.mime, isPublic ? 'public, max-age=3600' : 'private, no-store');
  });

  // Downloads for the team: the original file (f=original) or the MP3 (f=mp3)
  r.get('/download/:id', (req, res) => {
    const a = db.get('SELECT * FROM audio_files WHERE id = ?', Number.parseInt(req.params.id, 10));
    if (!a || !member(req, a.podcast_id)) return res.status(404).end();
    const mp3 = req.query.f === 'mp3';
    if (mp3 && !a.mp3_path) return res.status(404).end();
    const file = path.join(DATA_DIR, mp3 ? a.mp3_path : a.original_path);
    const base = a.original_name.replace(/\.[^.]+$/, '');
    const name = mp3 ? `${base}.mp3` : a.variant === 'cut' ? `${base}${path.extname(a.original_path)}` : a.original_name;
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(file, name);
  });

  const IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  r.get('/cover/:type/:id', (req, res) => {
    const id = Number(req.params.id);
    let rel = null, isPublic = true;
    if (req.params.type === 'podcast') rel = db.get('SELECT cover_path FROM podcasts WHERE id = ?', id)?.cover_path;
    else if (req.params.type === 'episode') {
      const ep = db.get('SELECT cover_path, status, podcast_id FROM episodes WHERE id = ?', id);
      isPublic = ep?.status === 'published';
      if (ep && !isPublic && !member(req, ep.podcast_id)) return res.status(403).end();
      rel = ep?.cover_path;
    }
    if (!rel) return res.status(404).end();
    res.setHeader('Content-Type', IMG[path.extname(rel).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, no-store');
    res.sendFile(path.join(DATA_DIR, rel));
  });

  return r;
}
