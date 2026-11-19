// Transcript helpers. Words are {w, s, e, sp, f, c}:
// w = word, s/e = start/end in seconds, sp = speaker id, f = filler (1/0), c = confidence

import { isFiller } from './languages.js';

export { isFiller };

export function markFillers(words, lang) {
  return words.map((w) => ({ ...w, f: isFiller(w.w, lang) ? 1 : 0 }));
}

// Validates and normalises words coming from the editor or the worker
export function sanitizeWords(input) {
  if (!Array.isArray(input)) throw new Error('words must be an array');
  const out = [];
  let last = 0;
  for (const x of input) {
    const w = String(x.w ?? '').trim();
    if (!w) continue;
    let s = Number(x.s), e = Number(x.e);
    if (!Number.isFinite(s)) s = last;
    if (!Number.isFinite(e) || e < s) e = s;
    const item = { w, s: round(s), e: round(e), sp: x.sp ? String(x.sp).slice(0, 40) : null, f: x.f ? 1 : 0 };
    if (x.c != null && Number.isFinite(Number(x.c))) item.c = Math.round(Number(x.c) * 100) / 100;
    out.push(item);
    last = e;
  }
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;

// Fills missing timestamps (e.g. words Whisper could not align) by interpolation
export function fillMissingTimes(words) {
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].s != null && out[i].e != null) continue;
    const prev = out[i - 1];
    let j = i;
    while (j < out.length && (out[j].s == null || out[j].e == null)) j++;
    const start = prev ? prev.e : 0;
    const end = j < out.length ? out[j].s : start + (j - i) * 0.3;
    const step = (end - start) / (j - i);
    for (let k = i; k < j; k++) { out[k].s = round(start + step * (k - i)); out[k].e = round(start + step * (k - i + 1)); }
    i = j - 1;
  }
  return out;
}

// Groups words into paragraphs: speaker change, pause > 1.5 s, or > 60 words at a sentence end
export function toParagraphs(words) {
  const paras = [];
  let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const breakHere = !cur || w.sp !== cur.sp || (prev && w.s - prev.e > 1.5) ||
      (cur.idx.length > 60 && /[.!?]$/.test(prev?.w || ''));
    if (breakHere) { cur = { sp: w.sp, start: w.s, idx: [] }; paras.push(cur); }
    cur.idx.push(i);
    cur.end = w.e;
  });
  return paras;
}

export function wordsToText(words, from = 0, to = Infinity) {
  return words.filter((w) => w.s >= from && w.s < to && !w.f).map((w) => w.w).join(' ');
}

// Text for Claude: paragraphs with start time and speaker
export function transcriptForPrompt(words, speakerNames = {}) {
  return toParagraphs(words).map((p) => {
    const text = p.idx.map((i) => words[i]).filter((w) => !w.f).map((w) => w.w).join(' ');
    const name = speakerNames[p.sp] || p.sp || 'Speaker';
    return `[${p.start.toFixed(1)}] ${name}: ${text}`;
  }).join('\n');
}

// Pauses between words (basis for the planned auto-cut module)
export function pauses(words, minGap = 0.7) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].s - words[i - 1].e;
    if (gap >= minGap) out.push({ after: i - 1, start: words[i - 1].e, end: words[i].s, gap: round(gap) });
  }
  return out;
}

// Rebuild the full-text index (one row per paragraph)
export function reindexTranscript(db, episodeId, podcastId, words) {
  db.run('DELETE FROM transcript_fts WHERE episode_id = ?', episodeId);
  for (const p of toParagraphs(words)) {
    const text = p.idx.map((i) => words[i].w).join(' ');
    db.run('INSERT INTO transcript_fts (text, episode_id, podcast_id, start) VALUES (?,?,?,?)', text, episodeId, podcastId, p.start);
  }
}

// Counts changed words (for the change log)
export function diffCount(a, b) {
  let n = Math.abs(a.length - b.length);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i].w !== b[i].w || a[i].sp !== b[i].sp) n++;
  return n;
}
