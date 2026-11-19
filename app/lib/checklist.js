// Per-episode checklist. auto: computed from the data; manual: ticked by hand.
// Labels are translation keys: `check.<key>`.
export const STEPS = [
  { key: 'audio', auto: true },
  { key: 'sound', auto: false },
  { key: 'transcript', auto: true },
  { key: 'transcript_review', auto: false },
  { key: 'chapters_tags', auto: false },
  { key: 'teasers', auto: true, stage: 2 },
  { key: 'moderation', auto: true, stage: 2 },
  { key: 'intro', auto: true, stage: 2 },
  { key: 'metadata', auto: true },
  { key: 'consent', auto: false, needsDate: true },
  { key: 'guest_share', auto: false, onlyIf: 'guest_share_enabled' },
  { key: 'explicit_warnings', auto: false },
  { key: 'published', auto: true },
];

export function computeChecklist(db, episode) {
  const manual = Object.fromEntries(
    db.all(`SELECT c.step, c.done, c.done_at, u.name AS done_by FROM checklist c LEFT JOIN users u ON u.id = c.done_by
            WHERE c.episode_id = ?`, episode.id).map((r) => [r.step, r]));
  const has = (sql, ...p) => !!db.get(sql, ...p);
  const cover = episode.cover_path || db.get('SELECT cover_path FROM podcasts WHERE id = ?', episode.podcast_id)?.cover_path;
  const auto = {
    audio: has(`SELECT 1 FROM audio_files WHERE episode_id = ? AND kind = 'main' AND is_current = 1`, episode.id),
    transcript: has('SELECT 1 FROM transcripts WHERE episode_id = ?', episode.id),
    teasers: false, // stage 2
    moderation: has(`SELECT 1 FROM audio_files WHERE episode_id = ? AND kind = 'moderation' AND is_current = 1`, episode.id),
    intro: has(`SELECT 1 FROM audio_files WHERE episode_id = ? AND kind = 'intro' AND is_current = 1`, episode.id),
    metadata: !!(episode.title?.trim() && episode.description?.trim() && cover),
    published: episode.status === 'published',
  };
  const items = [];
  for (const step of STEPS) {
    if (step.onlyIf && !episode[step.onlyIf]) continue;
    const m = manual[step.key];
    items.push({
      ...step,
      labelKey: `check.${step.key}`,
      done: step.auto ? auto[step.key] : !!m?.done,
      doneBy: m?.done_by, doneAt: m?.done_at,
      detail: step.key === 'teasers' ? { key: 'check.teasersCount', params: { n: 0, of: 4 } }
        : step.key === 'consent' && episode.consent_date ? { key: 'check.onDate', params: { date: episode.consent_date } } : null,
    });
  }
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done);
  return { items, done, total: items.length, percent: Math.round((done / items.length) * 100), nextKey: next ? next.labelKey : 'check.allDone' };
}
