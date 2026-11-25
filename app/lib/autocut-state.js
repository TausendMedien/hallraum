// Auto-cut state of an episode, read from the database: settings, proposals, manual decisions,
// the current cut version and whether it is outdated. The cut logic itself is in autocut.js.

import { proposeCuts, ownCut, selectedRanges, resolveSettings, normalizeSettings, makeTimeline, mergeRanges } from './autocut.js';
import { currentAudio, currentCut, latestJob } from './episodes.js';

const parse = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

// Auto-cut is active when at least one of the three settings is not off
export const isActive = (s) => Boolean(s.pauses.on || s.hesitations !== 'off' || s.fillers !== 'off');

function sameRanges(a = [], b = []) {
  const x = mergeRanges(a), y = mergeRanges(b);
  return x.length === y.length && x.every((r, i) => Math.abs(r.start - y[i].start) < 0.002 && Math.abs(r.end - y[i].end) < 0.002);
}

export function autocutState(db, ep) {
  const podcast = db.get('SELECT autocut_settings, language FROM podcasts WHERE id = ?', ep.podcast_id);
  const settings = resolveSettings(podcast.autocut_settings, ep.autocut_settings);
  const tr = db.get('SELECT words, language, gaps, loudness, version FROM transcripts WHERE episode_id = ?', ep.id);
  const row = db.get('SELECT overrides, own_cuts FROM autocut WHERE episode_id = ?', ep.id);
  const overrides = parse(row?.overrides, {});
  const words = tr ? parse(tr.words, []) : [];
  const gaps = tr ? parse(tr.gaps, null) : null;
  const cuts = tr ? proposeCuts(words, settings, tr.language || podcast.language, gaps) : [];
  // The team's own cuts (any words, chosen by selecting text) – independent of the settings
  const own = tr ? parse(row?.own_cuts, []).map((o) => ownCut(words, o.start, o.end)).filter(Boolean) : [];
  cuts.push(...own);
  cuts.sort((x, y) => x.start - y.start || x.end - y.end);
  for (const c of cuts) {
    c.manual = Object.hasOwn(overrides, c.id);
    c.marked = c.manual ? Boolean(overrides[c.id]) : c.on;
  }
  const ranges = selectedRanges(cuts, overrides);
  const cut = currentCut(db, ep.id);
  const info = cut ? parse(cut.cut_info, {}) : null;
  return {
    settings,
    ownSettings: ep.autocut_settings != null,
    podcastSettings: normalizeSettings(podcast.autocut_settings),
    active: isActive(settings) || own.length > 0,
    ownCount: own.length,
    hasTranscript: Boolean(tr),
    transcriptVersion: tr?.version ?? null,
    measured: Array.isArray(gaps),
    loudness: tr ? parse(tr.loudness, null) : null,
    cuts,
    ranges,
    removed: Math.round(ranges.reduce((s, r) => s + r.end - r.start, 0) * 10) / 10,
    cut: cut ? {
      id: cut.id, duration: cut.duration, createdAt: cut.created_at, removed: info.removed ?? null,
      count: info.applied?.length ?? 0, hasMp3: Boolean(cut.mp3_path),
    } : null,
    outdated: cut ? !sameRanges(info.requested, ranges) : false,
    jobs: { analyze: jobInfo(latestJob(db, ep.id, 'analyze')), autocut: jobInfo(latestJob(db, ep.id, 'autocut')) },
  };
}

const jobInfo = (j) => (j ? { id: j.id, status: j.status, progress: j.progress, error: j.error, createdAt: j.created_at } : null);

// What listeners hear: the auto-cut version if there is a current one, otherwise the original.
// `timeline` translates times from the original recording (all stored times) to the played file.
export function listenerAudio(db, episodeId) {
  const cut = currentCut(db, episodeId);
  const audio = cut || currentAudio(db, episodeId, 'main');
  const applied = cut ? parse(cut.cut_info, {}).applied || [] : [];
  return { audio, cut: Boolean(cut), timeline: makeTimeline(applied) };
}

// Checklist: is the cut version done and up to date? (null = auto-cut not active)
export function autocutCheck(db, ep) {
  const podcast = db.get('SELECT autocut_settings FROM podcasts WHERE id = ?', ep.podcast_id);
  const own = db.get('SELECT own_cuts FROM autocut WHERE episode_id = ?', ep.id)?.own_cuts;
  if (!isActive(resolveSettings(podcast?.autocut_settings, ep.autocut_settings)) && !parse(own, []).length) return null; // cheap check first
  const s = autocutState(db, ep);
  if (!s.active) return null;
  return { done: Boolean(s.cut) && !s.outdated, outdated: s.outdated, hasCut: Boolean(s.cut) };
}
