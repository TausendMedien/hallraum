// Auto-cut: proposes cuts for pauses, hesitation sounds ("äh", "um") and filler words ("also", "like"),
// rates how sure each proposal is, and maps times between the original recording and the cut version.
// Pure functions without database access. See docs/auto-cut-plan.md.
//
// All times stay on the timeline of the original recording. A cut is a range [start, end) in seconds
// that is removed from the audio; makeTimeline() translates times for the cut version.

import { languageData, normWord } from './languages.js';

// Certainty groups, from least to most sure (the index is the rank)
export const GROUPS = ['unsure', 'likely', 'certain'];
// Per-type setting: which groups are marked for cutting
export const THRESHOLDS = ['off', 'certain', 'likely', 'all'];
const MIN_RANK = { certain: 2, likely: 1, all: 0 };

const PAUSE_KEYS = ['longerThan', 'shortenTo', 'turnLongerThan', 'turnShortenTo'];

export function defaultSettings() {
  return {
    // Pauses longer than `longerThan` are shortened to `shortenTo` seconds.
    // Pauses at a change of speaker (`turn…`) sound natural, so they get more generous values.
    pauses: { on: false, longerThan: 1.2, shortenTo: 0.7, turnLongerThan: 2.0, turnShortenTo: 1.0 },
    hesitations: 'off',
    fillers: 'off',
  };
}

// Accepts an object or JSON string; unknown or invalid values fall back to `base`
export function normalizeSettings(input, base = defaultSettings()) {
  let s = input;
  if (typeof s === 'string') { try { s = JSON.parse(s || '{}'); } catch { s = {}; } }
  if (!s || typeof s !== 'object') s = {};
  const out = { pauses: { ...base.pauses }, hesitations: base.hesitations, fillers: base.fillers };
  if (s.pauses && typeof s.pauses === 'object') {
    if ('on' in s.pauses) out.pauses.on = Boolean(s.pauses.on);
    for (const k of PAUSE_KEYS) {
      const n = Number(s.pauses[k]);
      if (s.pauses[k] != null && s.pauses[k] !== '' && Number.isFinite(n)) out.pauses[k] = round(Math.min(30, Math.max(0.1, n)));
    }
  }
  out.pauses.shortenTo = Math.min(out.pauses.shortenTo, out.pauses.longerThan);
  out.pauses.turnShortenTo = Math.min(out.pauses.turnShortenTo, out.pauses.turnLongerThan);
  for (const k of ['hesitations', 'fillers']) if (THRESHOLDS.includes(s[k])) out[k] = s[k];
  return out;
}

// Episode settings override the podcast's, key by key. NULL = use the podcast's settings.
export function resolveSettings(podcastSettings, episodeSettings) {
  const base = normalizeSettings(podcastSettings);
  return episodeSettings == null ? base : normalizeSettings(episodeSettings, base);
}

// For the database migration: the old single level → the new settings (null = all off)
const LEVELS = {
  soft: { pauses: { on: true }, hesitations: 'certain', fillers: 'off' },
  medium: { pauses: { on: true }, hesitations: 'likely', fillers: 'certain' },
  strong: { pauses: { on: true }, hesitations: 'all', fillers: 'likely' },
};
const LEVEL_ALIASES = { sanft: 'soft', mittel: 'medium', stark: 'strong' };
export function settingsFromLevel(level) {
  const l = LEVEL_ALIASES[level] || level;
  return LEVELS[l] ? normalizeSettings(LEVELS[l]) : null;
}

// ---------------------------------------------------------------------------------------------
// Filler words that are real words in some places. Per language and phrase:
//   next / prev: the filler is NOT proposed when the following / preceding word is in the list
//   turnStart:   the filler is NOT proposed at the start of a speaker's turn (it is an answer there)
const FILLER_RULES = {
  en: {
    so: { next: ['that', 'much', 'many', 'far', 'long', 'often', 'few', 'little', 'good', 'bad', 'big', 'great', 'happy', 'sorry', 'sure', 'on'],
      prev: ['think', 'hope', 'guess', 'said', 'do', 'did', 'not', 'and', 'or', 'even', 'just', 'is', 'was'] },
    like: { prev: ['i', 'you', 'we', 'they', 'would', 'id', 'youd', 'wed', 'theyd', 'dont', 'didnt', 'doesnt', 'to', 'really', 'also', 'just',
      'looks', 'look', 'looked', 'feel', 'feels', 'felt', 'sounds', 'sounded', 'seems', 'seemed', 'something', 'things', 'nothing', 'anything', 'would'],
    next: ['to', 'it', 'this', 'them', 'him', 'her', 'me', 'us'] },
    'kind of': { next: ['a', 'an', 'the', 'thing', 'things', 'person', 'people', 'stuff'] },
    'sort of': { next: ['a', 'an', 'the', 'thing', 'things', 'person', 'people', 'stuff'] },
    'you know': { next: ['what', 'how', 'why', 'where', 'who', 'when', 'that', 'the', 'a', 'him', 'her', 'it', 'them', 'me', 'us', 'if', 'about'] },
    'i mean': { next: ['it', 'that', 'this', 'what'] },
    actually: { prev: ['is', 'was', 'did', 'do', 'does'] },
  },
  de: {
    ja: { turnStart: true },
    genau: { turnStart: true, next: ['das', 'so', 'der', 'die', 'dem', 'den', 'wie', 'dann', 'hier', 'da', 'jetzt', 'richtig', 'gleich', 'umgekehrt', 'deshalb', 'deswegen'] },
    ne: { turnStart: true },
    eben: { turnStart: true, prev: ['gerade', 'soeben'] },
    halt: { next: ['an', 'stopp', 'die', 'den', 'das'] },
    also: { prev: ['ist', 'war', 'sind', 'waren'] },
  },
};

const ENDS_SENTENCE = /[.!?…]["»«“”')]*$/;
const PUNCT_AFTER = /[,;:–—-]["»«“”')]*$/;
const PAD_MIN_KEEP = 0.1;  // never close a gap completely
const PAD_MAX_KEEP = 0.4;  // after removing a word, keep at most this much silence
const TIGHT = 0.02;        // a word this close to its neighbour is hard to cut cleanly
const VERY_LONG_PAUSE = 5; // longer pauses may be intended (or music)

// Proposes cuts. Returns a list sorted by start, each:
//   { id, type: 'pause'|'hesitation'|'filler', start, end, from, to (word indices), group, reasons: [...], on }
// `gaps` (optional, from the worker's audio analysis): [{ start, end, quiet }] – measured loudness between words.
export function proposeCuts(words, settings, language, gaps = null) {
  const s = normalizeSettings(settings);
  const lang = languageData(language);
  const langKey = Object.keys(FILLER_RULES).find((k) => languageData(k) === lang);
  const rules = FILLER_RULES[langKey] || {};
  const norm = words.map((w) => normWord(w.w));
  const hard = new Set(lang.fillers);
  const isHesitation = (i) => Boolean(words[i]?.f) || hard.has(norm[i]);
  const phrases = lang.softFillers.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);

  const turnStart = (i) => i === 0 || words[i - 1].sp !== words[i].sp;
  const turnEnd = (j) => j === words.length - 1 || words[j + 1].sp !== words[j].sp;
  const gapBefore = (i) => (i > 0 && !turnStart(i) ? words[i].s - words[i - 1].e : null);
  const gapAfter = (j) => (j < words.length - 1 && !turnEnd(j) ? words[j + 1].s - words[j].e : null);
  const out = [];

  // Hesitation sounds: start as "certain", lose a group for each warning sign
  if (s.hesitations !== 'off') {
    for (let i = 0; i < words.length; i++) {
      if (!isHesitation(i)) continue;
      const w = words[i];
      const cut = wordCut(words, i, i);
      let rank = 2;
      const reasons = ['hesitation'];
      if (w.c != null && w.c < 0.5) { rank--; reasons.push('lowConfidence'); }
      const dur = w.e - w.s;
      if (dur < 0.08 || dur > 1.5) { rank--; reasons.push('oddLength'); }
      if (cut.tight) { rank--; reasons.push('tight'); }
      out.push(item('hesitation', i, i, cut, rank, reasons, s.hesitations));
    }
  }

  // Filler words: start as "unsure", gain a group for each sign that they carry no meaning
  if (s.fillers !== 'off') {
    for (let i = 0; i < words.length; i++) {
      if (isHesitation(i)) continue;
      const phrase = phrases.find((p) => p.every((tok, k) => norm[i + k] === tok && words[i + k]?.sp === words[i].sp));
      if (!phrase) continue;
      const j = i + phrase.length - 1;
      const key = phrase.join(' ');
      const rule = rules[key] || {};
      const prev = norm[i - 1], next = norm[j + 1];
      // Never proposed: a whole turn ("Ja." "Genau.") or a short answer at the start of a turn.
      // The prev/next rules only apply when no punctuation separates the words ("ist also" vs. "ist, also,").
      const joinedBefore = !turnStart(i) && !PUNCT_AFTER.test(words[i - 1].w) && !ENDS_SENTENCE.test(words[i - 1].w);
      const joinedAfter = !turnEnd(j) && !PUNCT_AFTER.test(words[j].w) && !ENDS_SENTENCE.test(words[j].w);
      const blocked = (turnStart(i) && (turnEnd(j) || ENDS_SENTENCE.test(words[j].w))) ||
        (rule.turnStart && turnStart(i)) ||
        (joinedBefore && rule.prev?.includes(prev)) ||
        (joinedAfter && rule.next?.includes(next));
      if (blocked) { i = j; continue; }

      const cut = wordCut(words, i, j);
      const gb = gapBefore(i), ga = gapAfter(j);
      const sentenceStart = turnStart(i) || ENDS_SENTENCE.test(words[i - 1].w);
      const markAfter = PUNCT_AFTER.test(words[j].w);
      let rank = 0;
      const reasons = ['filler'];
      if (sentenceStart && (markAfter || (ga != null && ga >= 0.3))) { rank++; reasons.push('sentenceStart'); }
      if (!sentenceStart && PUNCT_AFTER.test(words[i - 1].w) && markAfter) { rank++; reasons.push('setOff'); }
      if (phrase.length === 1 && next === key && !turnEnd(j)) { rank++; reasons.push('repeated'); }
      if (gb != null && ga != null && gb >= 0.25 && ga >= 0.25) { rank++; reasons.push('pausesAround'); }
      if ((i > 0 && !turnStart(i) && isHesitation(i - 1)) || (!turnEnd(j) && isHesitation(j + 1))) { rank++; reasons.push('nextToHesitation'); }
      if (cut.tight) { rank--; reasons.push('tight'); }
      out.push(item('filler', i, j, cut, rank, reasons, s.fillers));
      i = j;
    }
  }

  // Pauses: rated by the measured loudness of the gap (if available)
  if (s.pauses.on) {
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i], b = words[i + 1];
      const turn = a.sp !== b.sp;
      const gap = b.s - a.e;
      const limit = turn ? s.pauses.turnLongerThan : s.pauses.longerThan;
      const keep = turn ? s.pauses.turnShortenTo : s.pauses.shortenTo;
      if (gap <= limit || gap - keep < 0.05) continue;
      const cut = { start: round(a.e + keep / 2), end: round(b.s - keep / 2) };
      const quiet = quietness(gaps, cut.start, cut.end);
      let rank = quiet === true ? 2 : quiet === false ? 0 : 1;
      const reasons = ['pause', quiet === true ? 'quiet' : quiet === false ? 'notQuiet' : 'notMeasured'];
      if (turn) { rank--; reasons.push('speakerChange'); }
      if (gap > VERY_LONG_PAUSE) { rank = 0; reasons.push('veryLong'); }
      // Pauses have no threshold setting: certain and likely ones are marked, unsure ones are left to a human
      out.push(item('pause', i, i + 1, cut, rank, reasons, 'likely'));
    }
  }

  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

function item(type, from, to, cut, rank, reasons, threshold) {
  const r = Math.max(0, Math.min(2, rank));
  return {
    id: `${type[0]}:${cut.start.toFixed(3)}`, type, start: cut.start, end: cut.end, from, to,
    group: GROUPS[r], reasons, on: threshold !== 'off' && r >= MIN_RANK[threshold],
  };
}

// The range to remove for words i..j, including part of the silence around them.
// What is left is about as long as the larger neighbouring gap, but at most PAD_MAX_KEEP.
function wordCut(words, i, j) {
  const prev = i > 0 && words[i - 1].sp === words[i].sp ? words[i - 1] : null;
  const next = j < words.length - 1 && words[j + 1].sp === words[j].sp ? words[j + 1] : null;
  const a = words[i].s, b = words[j].e;
  const gb = prev ? Math.max(0, a - prev.e) : 0;
  const ga = next ? Math.max(0, next.s - b) : 0;
  const total = gb + ga;
  const keep = Math.min(total, Math.max(PAD_MIN_KEEP, Math.min(Math.max(gb, ga), PAD_MAX_KEEP)));
  const kb = total ? keep * gb / total : 0;
  const ka = keep - kb;
  return {
    start: round(a - gb + kb), end: round(b + ga - ka),
    tight: Boolean((prev && gb < TIGHT) || (next && ga < TIGHT)),
  };
}

// true = measured and quiet, false = measured and not quiet (music, laughter, noise), null = not measured
function quietness(gaps, start, end) {
  if (!Array.isArray(gaps) || !gaps.length) return null;
  const over = gaps.filter((g) => g.end > start && g.start < end);
  if (!over.length) return null;
  if (over.some((g) => !g.quiet)) return false;
  const covered = over.reduce((sum, g) => sum + Math.min(g.end, end) - Math.max(g.start, start), 0);
  return covered >= (end - start) * 0.9 ? true : null;
}

// The ranges to remove: proposals that are on, with manual changes applied ({ [id]: true|false })
export function selectedRanges(cuts, overrides = {}) {
  return mergeRanges(cuts.filter((c) => (c.id in overrides ? Boolean(overrides[c.id]) : c.on)));
}

export function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r.end - r.start > 0.001).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

// Translates times between the original recording and the cut version.
// A time inside a removed range maps to the point where playback continues.
export function makeTimeline(ranges) {
  let removed = 0;
  const rows = mergeRanges(ranges).map((c) => {
    const row = { start: c.start, end: c.end, at: c.start - removed };
    removed += c.end - c.start;
    row.after = removed;
    return row;
  });
  const toCut = (t) => {
    let shift = 0;
    for (const c of rows) {
      if (t >= c.end) shift = c.after;
      else { if (t > c.start) return round(c.at); break; }
    }
    return round(t - shift);
  };
  const toOriginal = (t) => {
    let shift = 0;
    for (const c of rows) { if (t >= c.at) shift = c.after; else break; }
    return round(t + shift);
  };
  return { cuts: rows.map((c) => ({ start: c.start, end: c.end })), removed: round(removed), toCut, toOriginal };
}

const round = (n) => Math.round(n * 1000) / 1000;
