// Change log: every write is stored with user and time.
// Summaries are stored language-neutral as {k: key, p: params} and translated when shown.
// Param values starting with "@" are themselves translation keys (e.g. field labels).
const str = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

export function logChange(db, { user, podcastId, episodeId, type, id, field, oldValue, newValue, key, params }) {
  db.run(`INSERT INTO changes (user_id, podcast_id, episode_id, object_type, object_id, field, old_value, new_value, summary)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    user?.id, podcastId, episodeId, type, id, field, str(oldValue), str(newValue), JSON.stringify({ k: key, p: params || {} }));
}

// Compares old and new values and logs every changed field separately.
// labels: { field: 'label.key' }, extra params are merged into each entry.
export function logFieldChanges(db, ctx, before, after, labels, extra = {}) {
  let n = 0;
  for (const [field, labelKey] of Object.entries(labels)) {
    if (!(field in after)) continue;
    const a = before?.[field] ?? null;
    const b = after[field] ?? null;
    if (String(a ?? '') === String(b ?? '')) continue;
    logChange(db, { ...ctx, field, oldValue: a, newValue: b, key: extra.key || 'log.fieldChanged', params: { ...extra.params, field: '@' + labelKey } });
    n++;
  }
  return n;
}

export function renderSummary(t, summary) {
  let s;
  try { s = JSON.parse(summary); } catch { return summary; }
  if (!s || typeof s !== 'object' || !s.k) return String(summary);
  const p = {};
  for (const [k, v] of Object.entries(s.p || {})) p[k] = typeof v === 'string' && v.startsWith('@') ? t(v.slice(1)) : v;
  return t(s.k, p);
}

export function episodeHistory(db, episodeId, limit = 100) {
  return db.all(`SELECT c.*, u.name AS user_name FROM changes c LEFT JOIN users u ON u.id = c.user_id
                 WHERE c.episode_id = ? ORDER BY c.id DESC LIMIT ?`, episodeId, limit);
}

export function lastChange(db, episodeId) {
  return db.get(`SELECT c.at, u.name AS user_name, c.summary FROM changes c LEFT JOIN users u ON u.id = c.user_id
                 WHERE c.episode_id = ? ORDER BY c.id DESC LIMIT 1`, episodeId);
}
