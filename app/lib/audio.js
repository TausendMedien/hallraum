import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

// ffmpeg is optional: without ffmpeg on the server the transcription worker creates the MP3.
let ffmpegPath = null;
export function findFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath || null;
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { timeout: 5000 });
      if (r.status === 0) { ffmpegPath = c; return c; }
    } catch {}
  }
  ffmpegPath = '';
  return null;
}

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
};

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg error ${code}: ${err.slice(-500)}`))));
  });
}

export async function probeDuration(file) {
  const bin = findFfmpeg();
  if (!bin) return null;
  const out = await run(bin, ['-hide_banner', '-i', file, '-f', 'null', '-']).catch((e) => e.message);
  const all = [...String(out).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const m = all.at(-1) || String(out).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// Mono speech: 128 kbit/s MP3, 44.1 kHz – a good compromise for podcasts
export async function toMp3(input, output) {
  const bin = findFfmpeg();
  if (!bin) throw new Error('ffmpeg not available');
  const tmp = output + '.part.mp3';
  await run(bin, ['-hide_banner', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '128k', tmp]);
  fs.renameSync(tmp, output);
  return output;
}

// Serves a file with HTTP range support (for seeking in the player)
export function sendRange(req, res, file, mime, cacheControl = 'private, max-age=3600') {
  let stat;
  try { stat = fs.statSync(file); } catch { return res.status(404).end(); }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cacheControl);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = stat.size - parseInt(m[2], 10); end = stat.size - 1; }
    if (start >= stat.size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${stat.size}`); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
